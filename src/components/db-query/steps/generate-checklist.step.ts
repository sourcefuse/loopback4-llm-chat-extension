import {inject} from '@loopback/core';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DbSchemaHelperService} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {DbQueryConfig} from '../types';
import {idToString, tracedGenerateText} from './_helpers';
import type {BranchResult} from './constants';
import {
  STEP_GENERATE_CHECKLIST,
  STEP_GET_COLUMNS,
  STEP_RETURN_CACHED,
  STEP_SAVE_FROM_TEMPLATE,
} from './constants';
import {
  CHECKLIST_MIN_TABLES,
  mergeChecklist,
  selectDomainRules,
} from './checklist.shared';

function normaliseChecklist(raw: string): string {
  const trimmed = raw.trim();
  if (/^(none|n\/?a|\(none\)|no constraints?\.?)$/i.test(trimmed)) return '';
  return trimmed;
}

// Mastra wraps each branch arm's output as { [stepId]: stepOutput }, so we
// still resolve by step ID to unwrap the envelope — but we then dispatch on
// the shared `kind` discriminant instead of inferring shape from which key
// happened to be non-null.
function extractBranchResult(wrapped: Record<string, unknown>): BranchResult {
  const result = (wrapped[STEP_RETURN_CACHED] ??
    wrapped[STEP_SAVE_FROM_TEMPLATE] ??
    wrapped[STEP_GET_COLUMNS]) as BranchResult | undefined;
  // Fallback: treat unrecognised input as an empty continue pass
  return result ?? {kind: 'continue', prompt: '', tables: []};
}

async function generateChecklistText(
  chatLlm: LanguageModel | undefined,
  prompt: string,
  tables: string[],
  tracing?: TracingContext,
): Promise<string> {
  if (!chatLlm || !prompt) return '';
  const llmPrompt = `You are a SQL planning assistant. List ONLY the constraints the user EXPLICITLY stated in their request — specific filters, sort orders, row limits, or named columns they asked for. Do NOT invent filters, exclusions, sort orders, joins, or columns the user did not mention. If the request states no explicit constraints beyond the data wanted, return nothing.

User request: ${prompt}
Available tables: ${tables.join(', ') || '(none)'}

Return ONLY the explicit constraints as plain-text bullets, or an empty response if there are none.`;

  try {
    const result = await tracedGenerateText({
      model: chatLlm,
      prompt: llmPrompt,
      tracing,
      label: 'generate-checklist',
      resultType: 'planning',
    });
    return normaliseChecklist(result.text);
  } catch {
    return '';
  }
}

/**
 * Cached/template branch arms carry an existing dataset id straight through (no
 * SQL generation). Extracted from `execute` to keep it under the cyclomatic
 * complexity cap (S1541).
 */
function buildEnvelopeResult(
  branchResult: Extract<BranchResult, {kind: 'cached' | 'template'}>,
) {
  if (!branchResult.datasetId) {
    return {prompt: '', tables: [], checklist: '', attempts: 0};
  }
  return {
    prompt: '',
    tables: [],
    checklist: '',
    attempts: 0,
    cached: true,
    datasetId: idToString(branchResult.datasetId),
    sql: branchResult.sql ?? '',
  };
}

/**
 * First checklist pass (the Mastra-named successor of the LangGraph
 * GenerateChecklistNode). DI-resolved `@step` class.
 */
@step(STEP_GENERATE_CHECKLIST)
export class GenerateChecklistStep implements IWorkflowStep {
  constructor(
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    private readonly config?: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly globalContext: string[] = [],
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject('services.DbSchemaHelperService', {optional: true})
    private readonly schemaHelper?: DbSchemaHelperService,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
  ) {}

  async execute({inputData, tracingContext}: WorkflowStepCtx) {
    const wrapped = inputData as Record<string, unknown>;
    const branchResult = extractBranchResult(wrapped);

    if (branchResult.kind !== 'continue') {
      return buildEnvelopeResult(branchResult);
    }

    // kind === 'continue'
    const {prompt, tables, unanswerable, replyToUser, sampleSql, samplePrompt} =
      branchResult;
    const sample = {sampleSql, samplePrompt};

    // The get-columns gate judged the question unanswerable — carry the
    // verdict straight through so sql-and-validate skips SQL generation.
    if (unanswerable) {
      return {
        prompt,
        tables: [],
        checklist: '',
        attempts: 0,
        unanswerable: true,
        replyToUser: replyToUser ?? '',
      };
    }

    // Gate the checklist LLM call (restores v2 generate-checklist.node):
    //   - skip when the consumer disabled it (`enabled === false`), and
    //   - skip on <=2 tables where the planning value doesn't pay for the
    //     extra round-trip.
    const config = this.config;
    const checklistDisabled =
      config?.nodes?.generateChecklistNode?.enabled === false;
    if (checklistDisabled || tables.length <= CHECKLIST_MIN_TABLES) {
      return {prompt, tables, checklist: '', attempts: 0, ...sample};
    }

    const cheap = this.cheapModel ?? this.chatModel;

    // Two independent cheap-tier LLM passes — run concurrently:
    //   1. user-stated explicit constraints (filters/sorts/limits), and
    //   2. the GlobalContext + per-table domain rules relevant to this query
    //      (v2 generate-checklist.node) — so validation ENFORCES domain rules,
    //      not just the SQL-gen prompt.
    const [userChecklist, domainRules] = await Promise.all([
      generateChecklistText(cheap, prompt, tables, tracingContext),
      selectDomainRules({
        globalContext: this.globalContext,
        schemaStore: this.schemaStore,
        schemaHelper: this.schemaHelper,
        llm: cheap,
        prompt,
        tables,
        label: 'generate-checklist-rules',
        parallelism: config?.nodes?.generateChecklistNode?.parallelism ?? 1,
        tracing: tracingContext,
      }),
    ]);

    const checklist = mergeChecklist(userChecklist, domainRules);

    return {prompt, tables, checklist, attempts: 0, ...sample};
  }
}

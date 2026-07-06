import {inject, service} from '@loopback/core';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DbSchemaHelperService} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {DbQueryConfig} from '../types';
import {idToString, tracedGenerateText} from '../_helpers';
import type {BranchResult} from '../constants';
import {DbQueryNodes} from '../nodes.enum';
import {CHECKLIST_MIN_TABLES} from '../checklist.shared';
import {ChecklistHelper} from '../services/checklist-helper.service';

/**
 * First checklist pass (the successor of the LangGraph GenerateChecklistNode). A
 * DI-resolved `@graphNode` class. The normalise/extract/generate/envelope
 * helpers live on the class as `protected` methods so a host can `extends
 * GenerateChecklistNode` and override a single step (e.g. the checklist prompt),
 * then rebind under `@graphNode(DbQueryNodes.GenerateChecklist)`.
 */
@graphNode(DbQueryNodes.GenerateChecklist)
export class GenerateChecklistNode implements IGraphNode {
  constructor(
    // ponytail: optional + default instance keeps the node zero-arg
    // constructible (the node registry's `new () =>` contract); DI injects the
    // bound (rebindable) service when the component is mounted.
    @service(ChecklistHelper, {optional: true})
    protected readonly checklistHelper: ChecklistHelper = new ChecklistHelper(),
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    protected readonly config?: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    protected readonly globalContext: string[] = [],
    @inject('services.SchemaStore', {optional: true})
    protected readonly schemaStore?: SchemaStore,
    @inject('services.DbSchemaHelperService', {optional: true})
    protected readonly schemaHelper?: DbSchemaHelperService,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
  ) {}

  async execute({inputData, tracingContext}: GraphNodeCtx) {
    const wrapped = inputData as Record<string, unknown>;
    const branchResult = this.extractBranchResult(wrapped);

    if (branchResult.kind !== 'continue') {
      return this.buildEnvelopeResult(branchResult);
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
      this.generateChecklistText(cheap, prompt, tables, tracingContext),
      this.checklistHelper.selectDomainRules({
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

    const checklist = this.checklistHelper.mergeChecklist(
      userChecklist,
      domainRules,
    );

    return {prompt, tables, checklist, attempts: 0, ...sample};
  }

  protected normaliseChecklist(raw: string): string {
    const trimmed = raw.trim();
    if (/^(none|n\/?a|\(none\)|no constraints?\.?)$/i.test(trimmed)) return '';
    return trimmed;
  }

  // Mastra wraps each branch arm's output as { [stepId]: stepOutput }, so we
  // still resolve by step ID to unwrap the envelope — but we then dispatch on
  // the shared `kind` discriminant instead of inferring shape from which key
  // happened to be non-null.
  protected extractBranchResult(
    wrapped: Record<string, unknown>,
  ): BranchResult {
    const result = (wrapped[DbQueryNodes.ReturnCached] ??
      wrapped[DbQueryNodes.SaveFromTemplate] ??
      wrapped[DbQueryNodes.GetColumns]) as BranchResult | undefined;
    // Fallback: treat unrecognised input as an empty continue pass
    return result ?? {kind: 'continue', prompt: '', tables: []};
  }

  protected async generateChecklistText(
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
      return this.normaliseChecklist(result.text);
    } catch {
      return '';
    }
  }

  /**
   * Cached/template branch arms carry an existing dataset id straight through
   * (no SQL generation). Extracted from `execute` to keep it under the
   * cyclomatic complexity cap (S1541).
   */
  protected buildEnvelopeResult(
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
}

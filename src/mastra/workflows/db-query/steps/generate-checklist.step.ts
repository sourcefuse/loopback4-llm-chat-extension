import {createStep} from '@mastra/core/workflows';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {z} from 'zod';
import {
  getCheapLlm,
  getDbQueryConfig,
  idToString,
  tracedGenerateText,
} from '../_helpers';
import type {BranchResult} from './constants';
import {
  STEP_GET_COLUMNS,
  STEP_RETURN_CACHED,
  STEP_SAVE_FROM_TEMPLATE,
} from './constants';
import {
  CHECKLIST_MIN_TABLES,
  checklistStateSchema,
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

export const generateChecklistStep = createStep({
  id: 'generate-checklist',
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: checklistStateSchema,
  execute: async ({inputData, requestContext, tracingContext}) => {
    const wrapped = inputData as Record<string, unknown>;
    const branchResult = extractBranchResult(wrapped);

    if (branchResult.kind === 'cached' || branchResult.kind === 'template') {
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
    // get-columns stays always-on (it is the answerability gate), so this
    // is the one planning call that's safe to elide.
    const config = getDbQueryConfig(requestContext);
    const checklistDisabled =
      config?.nodes?.generateChecklistNode?.enabled === false;
    if (checklistDisabled || tables.length <= CHECKLIST_MIN_TABLES) {
      return {prompt, tables, checklist: '', attempts: 0, ...sample};
    }

    // Two independent cheap-tier LLM passes — run concurrently:
    //   1. user-stated explicit constraints (filters/sorts/limits), and
    //   2. the GlobalContext + per-table domain rules relevant to this query
    //      (v2 generate-checklist.node) — so validation ENFORCES domain rules,
    //      not just the SQL-gen prompt.
    const [userChecklist, domainRules] = await Promise.all([
      generateChecklistText(
        getCheapLlm(requestContext),
        prompt,
        tables,
        tracingContext,
      ),
      selectDomainRules({
        rc: requestContext,
        llm: getCheapLlm(requestContext),
        prompt,
        tables,
        label: 'generate-checklist-rules',
        parallelism: config?.nodes?.generateChecklistNode?.parallelism ?? 1,
        tracing: tracingContext,
      }),
    ]);

    const checklist = mergeChecklist(userChecklist, domainRules);

    return {prompt, tables, checklist, attempts: 0, ...sample};
  },
});

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
import {STEP_GET_COLUMNS} from './constants';

// The checklist LLM call only earns its latency on multi-table queries —
// single-/two-table requests have nowhere to mis-join, so v2 skipped it
// (generate-checklist.node tableCount<=2 guard). Mirror that here.
const CHECKLIST_MIN_TABLES = 2;

function normaliseChecklist(raw: string): string {
  const trimmed = raw.trim();
  if (/^(none|n\/?a|\(none\)|no constraints?\.?)$/i.test(trimmed)) return '';
  return trimmed;
}

function extractCachePassthrough(wrapped: Record<string, unknown>) {
  const hit = (wrapped['return-cached'] ??
    wrapped['save-dataset-from-template']) as
    | {datasetId?: string; sql?: string}
    | undefined;
  if (!hit?.datasetId) return null;
  return {
    prompt: '',
    tables: [] as string[],
    checklist: '',
    attempts: 0,
    cached: true,
    datasetId: idToString(hit.datasetId),
    sql: hit.sql ?? '',
  };
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
  inputSchema: z.any(),
  outputSchema: z.object({
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
    cached: z.boolean().optional(),
    datasetId: z.string().optional(),
    sql: z.string().optional(),
    unanswerable: z.boolean().optional(),
    replyToUser: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, tracingContext}) => {
    const wrapped = inputData as Record<string, unknown>;
    const cached = extractCachePassthrough(wrapped);
    if (cached) return cached;

    const fromGetColumns = wrapped[STEP_GET_COLUMNS] as
      | {
          prompt?: string;
          tables?: string[];
          unanswerable?: boolean;
          replyToUser?: string;
        }
      | undefined;
    const prompt =
      fromGetColumns?.prompt ?? (wrapped.prompt as string | undefined) ?? '';

    // The get-columns gate judged the question unanswerable — carry the
    // verdict straight through so sql-and-validate skips SQL generation.
    if (fromGetColumns?.unanswerable) {
      return {
        prompt,
        tables: [],
        checklist: '',
        attempts: 0,
        unanswerable: true,
        replyToUser: fromGetColumns.replyToUser ?? '',
      };
    }

    const tables =
      fromGetColumns?.tables ?? (wrapped.tables as string[] | undefined) ?? [];

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
      return {prompt, tables, checklist: '', attempts: 0};
    }

    const checklist = await generateChecklistText(
      getCheapLlm(requestContext),
      prompt,
      tables,
      tracingContext,
    );

    return {prompt, tables, checklist, attempts: 0};
  },
});

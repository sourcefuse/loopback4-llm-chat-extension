import {z} from 'zod';

export const MAX_VALIDATION_ATTEMPTS = 3;

// 'Failed' was present in v2 but is unreachable in v4 — classifyPostCacheStatus
// only returns 'AsIs', 'FromTemplate', or 'Continue'; removing it narrows the
// union and eliminates the dead branch.
export type DbQueryStatus = 'AsIs' | 'FromTemplate' | 'Continue';

export function classifyPostCacheStatus(
  cacheHit: boolean,
  templateMatched: boolean,
): DbQueryStatus {
  if (cacheHit) return 'AsIs';
  if (templateMatched) return 'FromTemplate';
  return 'Continue';
}

/** Span/log label for the SQL-generation LLM call. Extracted to avoid the
 *  Sonar S4325 duplicate-literal finding across logStepDetail + tracedGenerateText. */
export const LABEL_SQL_GENERATION = 'sql-generation';

export const inputSchema = z.object({
  prompt: z.string(),
});

// Unified entry contract for the single `dbQueryGraph` (both the
// get-data-as-dataset and improve-dataset tools call it). `datasetId` present
// selects the improve path, absent the generate path — the Mastra equivalent of
// LangGraph's `IsImprovement` dispatch at START of the one DbQueryGraph.
export const dbQueryInputSchema = z.object({
  prompt: z.string(),
  datasetId: z.string().optional(),
});

export const outputSchema = z.object({
  datasetId: z.string(),
  sql: z.string(),
  // Present only on the unanswerable fast-fail path — a short message the
  // tool hands to the agent so the user is asked to rephrase instead of
  // receiving a silent empty dataset.
  replyToUser: z.string().optional(),
});

// Discriminated-union schemas shared by all three .branch() arms in
// generate.workflow.ts. Every arm returns the same structural contract so
// generateChecklistNode can dispatch on `kind` instead of probing by step ID.
export const branchCachedSchema = z.object({
  kind: z.literal('cached'),
  datasetId: z.string(),
  sql: z.string(),
  replyToUser: z.string().optional(),
});

export const branchTemplateSchema = z.object({
  kind: z.literal('template'),
  datasetId: z.string(),
  sql: z.string(),
  replyToUser: z.string().optional(),
});

export const branchContinueSchema = z.object({
  kind: z.literal('continue'),
  prompt: z.string(),
  tables: z.array(z.string()),
  templateId: z.string().optional(),
  unanswerable: z.boolean().optional(),
  replyToUser: z.string().optional(),
  sampleSql: z.string().optional(),
  samplePrompt: z.string().optional(),
});

export const branchResultSchema = z.discriminatedUnion('kind', [
  branchCachedSchema,
  branchTemplateSchema,
  branchContinueSchema,
]);

export type BranchResult = z.infer<typeof branchResultSchema>;

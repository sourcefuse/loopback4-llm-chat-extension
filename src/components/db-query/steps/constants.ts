import {z} from 'zod';

export const MAX_VALIDATION_ATTEMPTS = 3;

export const STEP_CHECK_CACHE = 'check-cache';
export const STEP_GET_TABLES = 'get-tables';
export const STEP_CHECK_TEMPLATES = 'check-templates';
export const STEP_GET_COLUMNS = 'get-columns';
export const STEP_SQL_AND_VALIDATE = 'sql-and-validate';
export const STEP_RETURN_CACHED = 'return-cached';
export const STEP_SAVE_FROM_TEMPLATE = 'save-dataset-from-template';
export const STEP_POST_CACHE_AND_TABLES = 'post-cache-and-tables';
export const STEP_SAVE_DATASET = 'save-dataset';
export const STEP_GENERATE_CHECKLIST = 'generate-checklist';
export const STEP_VERIFY_CHECKLIST = 'verify-checklist';
// Mastra step id of the terminal failure step (shared by generate + improve).
export const STEP_FAILED = 'failed';
// improve-workflow step keys. NOTE: the improve terminal step keeps the Mastra
// id 'failed' (STEP_FAILED) inside its own workflow, but its DI *resolver key*
// must be globally unique, so it is registered/tagged as 'improve-failed'.
export const STEP_LOAD_EXISTING = 'load-existing';
export const STEP_FIX_QUERY = 'fix-query';
export const STEP_SAVE_IMPROVED = 'save-improved';
export const STEP_IMPROVE_FAILED = 'improve-failed';

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
// generateChecklistStep can dispatch on `kind` instead of probing by step ID.
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

import {z} from 'zod';

export const MAX_VALIDATION_ATTEMPTS = 3;

export const STEP_CHECK_CACHE = 'check-cache';
export const STEP_GET_TABLES = 'get-tables';
export const STEP_CHECK_TEMPLATES = 'check-templates';
export const STEP_GET_COLUMNS = 'get-columns';
export const STEP_SQL_AND_VALIDATE = 'sql-and-validate';

export type DbQueryStatus = 'AsIs' | 'FromTemplate' | 'Failed' | 'Continue';

export function classifyPostCacheStatus(
  cacheHit: boolean,
  templateMatched: boolean,
): DbQueryStatus {
  if (cacheHit) return 'AsIs';
  if (templateMatched) return 'FromTemplate';
  return 'Continue';
}

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

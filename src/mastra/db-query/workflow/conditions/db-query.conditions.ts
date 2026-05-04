import {DbQueryState} from '../../../../components/db-query/state';
import {
  EvaluationResult,
  GenerationError,
} from '../../../../components/db-query/types';

/**
 * Routing outcomes after the parallel fan-in of CheckCache, GetTables,
 * CheckTemplates, and ClassifyChange. Mirrors the `PostCacheAndTables`
 * conditional-edge function in `DbQueryGraph._addEdges()`.
 */
export type PostCacheCondition =
  | 'fromTemplate'
  | 'fromCache'
  | 'failed'
  | 'continue';

/**
 * Evaluates the merged state after the initial parallel fan-out and returns
 * the appropriate routing decision.
 *
 * - `fromTemplate` → a pre-defined SQL template matched; skip generation.
 * - `fromCache`    → a semantically identical query was already in cache.
 * - `failed`       → a node (e.g. GetTables) already set status to Failed.
 * - `continue`     → proceed to column selection and SQL generation.
 *
 * Mirrors the `PostCacheAndTables` conditional edge in `DbQueryGraph`.
 */
export function checkPostCacheAndTablesConditions(
  state: DbQueryState,
): PostCacheCondition {
  if (state.fromTemplate) return 'fromTemplate';
  if (state.fromCache) return 'fromCache';
  if (state.status === GenerationError.Failed) return 'failed';
  return 'continue';
}

/**
 * Routing outcomes for the validation retry loop.
 * Mirrors the `PostValidation` conditional-edge function in `DbQueryGraph._addEdges()`.
 */
export type PostValidationCondition =
  | 'accepted'
  | 'fixSql'
  | 'reselectTables'
  | 'failed';

/**
 * Evaluates merged validation state and returns the next routing decision.
 * The `feedbackCount` guard (`>= MAX_ATTEMPTS`) is handled by the caller
 * before this function is invoked.
 *
 * Mirrors the `PostValidation` conditional edge in `DbQueryGraph`.
 */
export function checkPostValidationConditions(
  state: DbQueryState,
): PostValidationCondition {
  if (state.status === EvaluationResult.Pass) return 'accepted';
  if (state.status === EvaluationResult.TableError) return 'reselectTables';
  if (state.status === EvaluationResult.QueryError) return 'fixSql';
  return 'failed';
}

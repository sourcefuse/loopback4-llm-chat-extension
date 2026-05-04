import {DbQueryState} from '../../../../components/db-query/state';
import {EvaluationResult} from '../../../../components/db-query/types';

const debug = require('debug')(
  'ai-integration:mastra:db-query:post-validation',
);

/**
 * Merges syntactic and semantic validation results into a single unified status.
 *
 * Rules (mirror the LangGraph PostValidation node exactly):
 * - Both validators passed  → `Pass`; clear all per-round fields.
 * - Syntactic failure       → use syntactic status/feedback; accumulate feedbacks.
 * - Semantic failure only   → use semantic status/feedback; accumulate feedbacks.
 */
export function mergeValidationResults(
  state: DbQueryState,
): Partial<DbQueryState> {
  const hasSyntacticFailure = isValidationFailure(state.syntacticStatus);
  const hasSemanticFailure = isValidationFailure(state.semanticStatus);

  debug('mergeValidationResults', {
    syntacticStatus: state.syntacticStatus,
    semanticStatus: state.semanticStatus,
    hasSyntacticFailure,
    hasSemanticFailure,
  });

  if (!hasSyntacticFailure && !hasSemanticFailure) {
    debug('result: Pass — both validators cleared');
    return buildPassedResult(state);
  }

  debug(
    'result: Failed — syntactic=%s semantic=%s',
    hasSyntacticFailure,
    hasSemanticFailure,
  );
  return buildFailedResult(state, hasSyntacticFailure);
}

function isValidationFailure(status: DbQueryState['syntacticStatus']): boolean {
  return !!status && status !== EvaluationResult.Pass;
}

function buildPassedResult(state: DbQueryState): Partial<DbQueryState> {
  return {
    status: EvaluationResult.Pass,
    feedbacks: (state.feedbacks ?? []).filter(
      f => !f.startsWith('Query Validation Failed'),
    ),
    syntacticStatus: undefined,
    syntacticFeedback: undefined,
    syntacticErrorTables: undefined,
    semanticStatus: undefined,
    semanticFeedback: undefined,
    semanticErrorTables: undefined,
  };
}

function buildFailedResult(
  state: DbQueryState,
  hasSyntacticFailure: boolean,
): Partial<DbQueryState> {
  const clearedState = buildClearedState(state);
  const baseFeedbacks = state.feedbacks ?? [];
  const semanticFb = toArray(state.semanticFeedback);
  const syntacticFb = hasSyntacticFailure
    ? toArray(state.syntacticFeedback)
    : [];

  return {
    status: hasSyntacticFailure ? state.syntacticStatus : state.semanticStatus,
    feedbacks: [...baseFeedbacks, ...syntacticFb, ...semanticFb],
    ...clearedState,
  };
}

function buildClearedState(state: DbQueryState): Partial<DbQueryState> {
  const mergedErrorTables = [
    ...new Set([
      ...(state.syntacticErrorTables ?? []),
      ...(state.semanticErrorTables ?? []),
    ]),
  ];
  const errorTables =
    mergedErrorTables.length > 0 ? mergedErrorTables : undefined;
  return {
    syntacticStatus: undefined,
    syntacticFeedback: undefined,
    syntacticErrorTables: errorTables,
    semanticStatus: undefined,
    semanticFeedback: undefined,
    semanticErrorTables: errorTables,
  };
}

function toArray(value: string | undefined): string[] {
  return value ? [value] : [];
}

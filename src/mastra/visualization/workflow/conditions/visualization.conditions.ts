import {MastraVisualizationState} from '../../types/visualization.types';

// ── Post-SelectVisualization routing ─────────────────────────────────────────

/**
 * Routing outcomes after `selectVisualizationStep`.
 *
 * Mirrors the `addConditionalEdges` on `SelectVisualisation` in
 * `VisualizationGraph.build()`.
 */
export type PostSelectCondition = 'error' | 'continue';

/**
 * Evaluates state after `selectVisualizationStep` and returns the routing
 * decision.
 *
 * - `'error'`    → `state.error` is set; short-circuit to end without rendering.
 * - `'continue'` → proceed to `callQueryGenerationStep`.
 *
 * Mirrors the conditional edge after `SelectVisualisation` in the LangGraph
 * `VisualizationGraph`.
 */
export function checkPostSelectConditions(
  state: MastraVisualizationState,
): PostSelectCondition {
  if (state.error) return 'error';
  return 'continue';
}

// ── Post-CallQueryGeneration routing ─────────────────────────────────────────

/**
 * Routing outcomes after `callQueryGenerationStep`.
 *
 * Mirrors the `addConditionalEdges` on `CallQueryGeneration` in
 * `VisualizationGraph.build()`.
 */
export type PostQueryGenerationCondition = 'error' | 'continue';

/**
 * Evaluates state after `callQueryGenerationStep` and returns the routing
 * decision.
 *
 * - `'error'`    → dataset generation failed; short-circuit to end.
 * - `'continue'` → proceed to `getDatasetDataStep`.
 *
 * Mirrors the conditional edge after `CallQueryGeneration` in the LangGraph
 * `VisualizationGraph`.
 */
export function checkPostQueryGenerationConditions(
  state: MastraVisualizationState,
): PostQueryGenerationCondition {
  if (state.error) return 'error';
  return 'continue';
}

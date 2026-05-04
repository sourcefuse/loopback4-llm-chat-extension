import {LLMStreamEventType} from '../../../../types/events';
import {MastraDbQueryWorkflow} from '../../../db-query/mastra-db-query.workflow';
import {
  MastraVisualizationContext,
  MastraVisualizationState,
} from '../../types/visualization.types';

const debug = require('debug')(
  'ai-integration:mastra:visualization:call-query-generation',
);

/** Dependencies injected by `MastraVisualizationWorkflow`. */
export type CallQueryGenerationStepDeps = {
  /** The Mastra DB-Query workflow for generating a new dataset when needed. */
  dbQueryWorkflow: MastraDbQueryWorkflow;
};

/**
 * Calls the Mastra DbQuery workflow to generate a dataset when one has not
 * been provided by the caller.
 *
 * Short-circuits immediately if `state.datasetId` is already set — this
 * matches the LangGraph `CallQueryGenerationNode` behaviour where the node
 * was a no-op for pre-existing datasets.
 *
 * When dataset generation succeeds, the step returns `{ datasetId }`.
 * On failure it returns `{ error }` which causes the workflow to short-circuit
 * before reaching `renderVisualizationStep`.
 *
 * The prompt sent to the DbQuery workflow appends the selected visualizer's
 * `context` hint (e.g. "ensure exactly two columns") so the generated SQL is
 * already shaped for the chosen chart type.
 *
 * Mirrors `CallQueryGenerationNode.execute()` in the LangGraph path.
 * LangGraph coupling removed: `DbQueryGraph.build().invoke()` →
 * `MastraDbQueryWorkflow.run()`.
 */
export async function callQueryGenerationStep(
  state: MastraVisualizationState,
  context: MastraVisualizationContext,
  deps: CallQueryGenerationStepDeps,
): Promise<Partial<MastraVisualizationState>> {
  debug('step start datasetId=%s', state.datasetId ?? '(none)');

  // ── Short-circuit: dataset already known ─────────────────────────────────
  if (state.datasetId) {
    debug('datasetId already set, skipping query generation');
    return {};
  }

  // ── Build dataset-generation prompt with visualizer context hint ─────────
  const vizContext = state.visualizer?.context
    ? ` Ensure that the query structure satisfies the following context: ${state.visualizer.context}`
    : '';

  const dbQueryPrompt = `Generate a query to fetch data for visualization based on the following user prompt: ${state.prompt}.${vizContext}`;

  debug('Calling DbQuery workflow prompt=%s', dbQueryPrompt.substring(0, 120));

  // Forward writer/signal so the nested workflow can emit status events too
  const dbQueryResult = await deps.dbQueryWorkflow.run(
    {prompt: dbQueryPrompt, directCall: true},
    {writer: context.writer, signal: context.signal},
  );

  if (!dbQueryResult.datasetId) {
    const reason = dbQueryResult.replyToUser ?? 'Unknown error';
    debug('DbQuery workflow failed: %s', reason);
    context.writer?.({
      type: LLMStreamEventType.Error,
      data: {
        status: `Failed to create dataset for visualization: ${reason}`,
      },
    });
    return {
      error:
        dbQueryResult.replyToUser ??
        'Failed to create dataset for visualization',
    };
  }

  debug('Dataset generated: datasetId=%s', dbQueryResult.datasetId);
  return {datasetId: dbQueryResult.datasetId};
}

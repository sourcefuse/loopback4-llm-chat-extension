import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
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
 * Plain async function containing the business logic — callable without
 * the Mastra workflow runtime. Used by the workflow DSL directly.
 */
export async function runCallQueryGeneration(
  state: MastraVisualizationState,
  context: MastraVisualizationContext,
  deps: CallQueryGenerationStepDeps,
): Promise<Partial<MastraVisualizationState>> {
  debug('step start datasetId=%s', state.datasetId ?? '(none)');

  // ── Short-circuit: dataset already known ─────────────────────────────────────────
  if (state.datasetId) {
    debug('datasetId already set, skipping query generation');
    return {};
  }

  // ── Build dataset-generation prompt with visualizer context hint ─────────────────
  const vizContext = state.visualizer?.context
    ? ` Ensure that the query structure satisfies the following context: ${state.visualizer.context}`
    : '';

  const dbQueryPrompt = `Generate a query to fetch data for visualization based on the following user prompt: ${state.prompt}.${vizContext}`;

  debug('Calling DbQuery workflow prompt=%s', dbQueryPrompt.substring(0, 120));

  // Forward emit/signal so the nested workflow can emit status events too
  const dbQueryResult = await deps.dbQueryWorkflow.run(
    {prompt: dbQueryPrompt, directCall: true},
    {emit: context.emit, signal: context.signal},
  );

  if (!dbQueryResult.datasetId) {
    const reason = dbQueryResult.replyToUser ?? 'Unknown error';
    debug('DbQuery workflow failed: %s', reason);
    context.emit?.({
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
export const callQueryGenerationStep = createStep({
  id: 'visualization-call-query-generation',
  inputSchema: z.any(),
  outputSchema: z.any(),
  execute: async ({
    inputData,
  }: {
    inputData: {
      state: MastraVisualizationState;
      context: MastraVisualizationContext;
      deps: CallQueryGenerationStepDeps;
    };
  }): Promise<Partial<MastraVisualizationState>> => {
    const {state, context, deps} = inputData;
    return runCallQueryGeneration(state, context, deps);
  },
});

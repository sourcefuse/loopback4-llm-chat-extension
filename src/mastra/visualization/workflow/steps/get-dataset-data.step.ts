import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../types/events';
import {IDataSetStore} from '../../../../components/db-query/types';
import {
  MastraVisualizationContext,
  MastraVisualizationState,
} from '../../types/visualization.types';

const debug = require('debug')(
  'ai-integration:mastra:visualization:get-dataset-data',
);

/** Dependencies injected by `MastraVisualizationWorkflow`. */
export type GetDatasetDataStepDeps = {
  /** Dataset store used to fetch the SQL query and description. */
  store: IDataSetStore;
};

/**
 * Plain async function containing the business logic — callable without
 * the Mastra workflow runtime. Used by the workflow DSL directly.
 */
export async function runGetDatasetData(
  state: MastraVisualizationState,
  context: MastraVisualizationContext,
  deps: GetDatasetDataStepDeps,
): Promise<Partial<MastraVisualizationState>> {
  debug('step start datasetId=%s', state.datasetId);

  const dataset = await deps.store.findById(state.datasetId!);

  debug('Dataset fetched sql=%s', dataset.query?.substring(0, 80));

  context.emit?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Preparing visualization'},
  });

  return {
    sql: dataset.query,
    queryDescription: dataset.description,
  };
}

/**
 * Fetches the SQL query and human-readable description from the dataset store
 * using `state.datasetId`.
 *
 * Populates `state.sql` and `state.queryDescription` so that the subsequent
 * `renderVisualizationStep` can pass them to the visualizer's `getConfig()`.
 *
 * Also emits a "Preparing visualization" status event to the SSE transport.
 *
 * Mirrors `GetDatasetDataNode.execute()` in the LangGraph path.
 * LangGraph coupling removed: `@inject(DbQueryAIExtensionBindings.DatasetStore)` →
 * explicit `deps.store` parameter.
 */
export const getDatasetDataStep = createStep({
  id: 'visualization-get-dataset-data',
  inputSchema: z.any(),
  outputSchema: z.any(),
  execute: async ({
    inputData,
  }: {
    inputData: {
      state: MastraVisualizationState;
      context: MastraVisualizationContext;
      deps: GetDatasetDataStepDeps;
    };
  }): Promise<Partial<MastraVisualizationState>> => {
    const {state, context, deps} = inputData;
    return runGetDatasetData(state, context, deps);
  },
});

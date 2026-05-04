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
export async function getDatasetDataStep(
  state: MastraVisualizationState,
  context: MastraVisualizationContext,
  deps: GetDatasetDataStepDeps,
): Promise<Partial<MastraVisualizationState>> {
  debug('step start datasetId=%s', state.datasetId);

  const dataset = await deps.store.findById(state.datasetId!);

  debug('Dataset fetched sql=%s', dataset.query?.substring(0, 80));

  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Preparing visualization'},
  });

  return {
    sql: dataset.query,
    queryDescription: dataset.description,
  };
}

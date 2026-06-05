import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getDataSetHelper,
  getDatasetStore,
} from '../../db-query/_helpers';
import {
  DEFAULT_CHART_TYPE,
  fetchDatasetDescriptor,
  fetchDatasetRows,
  pickFromBranch,
  readString,
  STEP_GET_DATASET_DATA,
} from './shared';

export const getDatasetDataStep = createStep({
  id: STEP_GET_DATASET_DATA,
  inputSchema: z.any(),
  outputSchema: z.object({
    datasetId: z.string(),
    rows: z.array(z.unknown()),
    chartType: z.string(),
    userQuery: z.string(),
    sql: z.string().optional(),
    description: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    emitToolStatus(
      requestContext,
      STEP_GET_DATASET_DATA,
      'Preparing visualization',
    );

    const upstream = pickFromBranch(inputData, 'call-query-generation');
    const datasetId = readString(upstream.datasetId) ?? '';
    const chartType = readString(upstream.chartType) ?? DEFAULT_CHART_TYPE;
    const userQuery = readString(upstream.userQuery) ?? '';

    const {sql, description} = await fetchDatasetDescriptor(
      getDatasetStore(requestContext),
      datasetId,
    );
    const rows = await fetchDatasetRows(
      getDataSetHelper(requestContext),
      datasetId,
    );

    return {datasetId, rows, chartType, userQuery, sql, description};
  },
});

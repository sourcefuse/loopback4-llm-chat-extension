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
    rejected: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    emitToolStatus(
      requestContext,
      STEP_GET_DATASET_DATA,
      'Preparing visualization',
    );

    const upstream = pickFromBranch(inputData, 'call-query-generation');
    const chartType = readString(upstream.chartType) ?? DEFAULT_CHART_TYPE;
    const userQuery = readString(upstream.userQuery) ?? '';

    // No visualizer fit the request — skip the data fetch and carry the
    // rejection straight through to the render step.
    if (upstream.rejected) {
      return {
        datasetId: '',
        rows: [],
        chartType,
        userQuery,
        rejected: true,
        reason: readString(upstream.reason),
      };
    }

    const datasetId = readString(upstream.datasetId) ?? '';

    // Two independent reads — run concurrently.
    const [descriptor, rows] = await Promise.all([
      fetchDatasetDescriptor(getDatasetStore(requestContext), datasetId),
      fetchDatasetRows(
        getDataSetHelper(requestContext),
        datasetId,
        requestContext,
      ),
    ]);
    const {sql, description} = descriptor;

    return {datasetId, rows, chartType, userQuery, sql, description};
  },
});

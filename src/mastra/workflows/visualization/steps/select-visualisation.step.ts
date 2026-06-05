import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {emitToolStatus, getVisualizers} from '../../db-query/_helpers';
import {DEFAULT_CHART_TYPE} from './shared';

export const selectVisualisationStep = createStep({
  id: 'select-visualisation',
  inputSchema: z.object({
    datasetId: z.string(),
    userQuery: z.string(),
    type: z.string().optional(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
    userQuery: z.string(),
  }),
  execute: async ({inputData, requestContext}) => {
    emitToolStatus(
      requestContext,
      'select-visualisation',
      'Selecting best visualization for the data',
    );

    let chartType = inputData.type ?? DEFAULT_CHART_TYPE;
    if (!inputData.type) {
      const visualizers = getVisualizers(requestContext);
      if (visualizers.length > 0) chartType = visualizers[0].name;
    }

    return {
      datasetId: inputData.datasetId,
      needsQuery: !inputData.datasetId,
      chartType,
      userQuery: inputData.userQuery,
    };
  },
});

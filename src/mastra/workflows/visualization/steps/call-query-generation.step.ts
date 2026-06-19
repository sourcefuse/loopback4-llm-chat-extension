import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {asRecord, extractWorkflowResult, readString} from './shared';

export const callQueryGenerationStep = createStep({
  id: 'call-query-generation',
  inputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
    userQuery: z.string(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
    userQuery: z.string(),
  }),
  execute: async ({inputData, mastra, requestContext}) => {
    if (inputData.datasetId) {
      return {
        datasetId: inputData.datasetId,
        needsQuery: false,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
      };
    }

    const generate = mastra?.getWorkflow?.('generateQueryWorkflow');
    if (!generate) {
      return {
        datasetId: '',
        needsQuery: true,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
      };
    }

    const run = await generate.createRun();
    const result = await run.start({
      inputData: {
        prompt: `Generate a query to fetch data for visualization based on the following user prompt: ${inputData.userQuery}.`,
      },
      requestContext,
    });

    // Guard on status before extracting the result — if the nested workflow
    // failed/suspended/etc., extractWorkflowResult returns {} and datasetId
    // silently becomes '', sending the visualization step forward with no data.
    if (result.status !== 'success') {
      return {
        datasetId: '',
        needsQuery: true,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
      };
    }

    const rawOut = extractWorkflowResult(result);
    const saveDatasetOut = asRecord(rawOut['save-dataset']);
    const datasetId = readString(saveDatasetOut.datasetId ?? rawOut.datasetId);

    return {
      datasetId: datasetId ?? '',
      needsQuery: false,
      chartType: inputData.chartType,
      userQuery: inputData.userQuery,
    };
  },
});

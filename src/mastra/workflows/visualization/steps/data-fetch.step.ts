import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asVisualizationContext} from '../visualization-request-context';
import {visualizationWorkflowStateSchema} from '../visualization-workflow-schemas';

export const dataFetchStep = createStep({
  id: 'data-fetch',
  inputSchema: z.object({
    prompt: z.string(),
    datasetId: z.string().optional(),
    visualizerName: z.string().optional(),
    visualizerContext: z.string().optional(),
    type: z.string().optional(),
    error: z.string().optional(),
  }),
  outputSchema: visualizationWorkflowStateSchema,
  execute: async ({inputData, requestContext, writer}) => {
    if (inputData.error) {
      return inputData;
    }

    if (!inputData.datasetId) {
      throw new Error('Invalid State');
    }

    const ctx = asVisualizationContext(requestContext!);
    const dataset = await ctx.get('datasetStore').findById(inputData.datasetId);

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Preparing visualization',
      },
    });

    return {
      ...inputData,
      sql: dataset.query,
      queryDescription: dataset.description,
    };
  },
});

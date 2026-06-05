import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {emitToolStatus, getVisualizers} from '../../db-query/_helpers';
import {pickVisualizer, visualizationOutputSchema} from './shared';

export const renderVisualizationStep = createStep({
  id: 'render-visualization',
  inputSchema: z.object({
    datasetId: z.string(),
    rows: z.array(z.unknown()),
    chartType: z.string(),
    userQuery: z.string(),
    sql: z.string().optional(),
    description: z.string().optional(),
  }),
  outputSchema: visualizationOutputSchema,
  execute: async ({inputData, requestContext}) => {
    const visualizer = pickVisualizer(
      getVisualizers(requestContext),
      inputData.chartType,
    );

    emitToolStatus(
      requestContext,
      'render-visualization',
      `Configuring ${visualizer?.name ?? inputData.chartType}`,
    );

    if (!visualizer) {
      return {
        visualization: inputData.chartType,
        chartConfig: {},
        datasetId: inputData.datasetId,
        sql: inputData.sql,
        description: inputData.description,
      };
    }

    try {
      const chartConfig = await visualizer.getConfig({
        prompt: inputData.userQuery,
        datasetId: inputData.datasetId,
        sql: inputData.sql,
        queryDescription: inputData.description,
        visualizer,
        visualizerName: visualizer.name,
        done: true,
        type: inputData.chartType,
      });

      return {
        visualization: visualizer.name,
        chartConfig,
        datasetId: inputData.datasetId,
        sql: inputData.sql,
        description: inputData.description,
      };
    } catch {
      return {
        visualization: inputData.chartType,
        chartConfig: {},
        datasetId: inputData.datasetId,
        sql: inputData.sql,
        description: inputData.description,
      };
    }
  },
});

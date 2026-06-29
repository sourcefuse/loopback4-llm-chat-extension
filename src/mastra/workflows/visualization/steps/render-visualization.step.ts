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
    rejected: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  outputSchema: visualizationOutputSchema,
  execute: async ({inputData, requestContext}) => {
    // No visualizer fit the request (v2 "none" path). Surface the reason via
    // `error` so the tool can tell the user why, instead of forcing a chart.
    if (inputData.rejected) {
      return {
        visualization: undefined,
        chartConfig: {},
        datasetId: inputData.datasetId,
        error: inputData.reason ?? 'No suitable visualization for the request.',
      };
    }

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

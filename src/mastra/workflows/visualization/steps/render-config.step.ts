import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {ToolStatus} from '../../../../graphs/types';
import type {VisualizationGraphState} from '../../../../components/visualization/state';
import {asVisualizationContext} from '../visualization-request-context';
import {visualizationWorkflowOutputSchema} from '../visualization-workflow-schemas';

export const renderConfigStep = createStep({
  id: 'render-config',
  inputSchema: z.object({
    prompt: z.string(),
    datasetId: z.string().optional(),
    visualizerName: z.string().optional(),
    sql: z.string().optional(),
    queryDescription: z.string().optional(),
    type: z.string().optional(),
    error: z.string().optional(),
  }),
  outputSchema: visualizationWorkflowOutputSchema,
  execute: async ({inputData, requestContext, writer}) => {
    if (inputData.error) {
      return {
        datasetId: inputData.datasetId,
        visualizerName: inputData.visualizerName,
        done: false,
        error: inputData.error,
      };
    }

    const ctx = asVisualizationContext(requestContext!);
    const visualizerStore = ctx.get('visualizerStore');
    const visualizer = inputData.visualizerName
      ? visualizerStore.map[inputData.visualizerName]
      : undefined;

    if (
      !visualizer ||
      !inputData.sql ||
      !inputData.queryDescription ||
      !inputData.datasetId
    ) {
      throw new Error('Invalid State');
    }

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: `Configuring ${visualizer.name}`,
      },
    });

    const settings = await visualizer.getConfig({
      prompt: inputData.prompt,
      datasetId: inputData.datasetId,
      sql: inputData.sql,
      queryDescription: inputData.queryDescription,
      visualizerName: visualizer.name,
      type: inputData.type,
    } as VisualizationGraphState);

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: ToolStatus.Completed,
        data: {
          datasetId: inputData.datasetId,
          visualization: visualizer.name,
          config: settings || {},
        },
      },
    });

    return {
      datasetId: inputData.datasetId,
      visualizerName: visualizer.name,
      visualizerConfig: settings || {},
      done: true,
    };
  },
});

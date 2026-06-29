import {inject} from '@loopback/core';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {emitToolStatus} from '../../db-query/steps/_helpers';
import {VISUALIZATION_KEY} from '../keys';
import type {IVisualizer} from '../types';
import {pickVisualizer, STEP_RENDER_VISUALIZATION} from './shared';

type RenderIn = {
  datasetId: string;
  rows: unknown[];
  chartType: string;
  userQuery: string;
  sql?: string;
  description?: string;
  rejected?: boolean;
  reason?: string;
};

/**
 * Build the chart config via the selected visualizer (the Mastra-named
 * successor of the LangGraph RenderVisualization node). DI-resolved `@step`
 * class.
 */
@step(STEP_RENDER_VISUALIZATION)
export class RenderVisualizationStep implements IWorkflowStep<RenderIn> {
  constructor(
    @inject.tag(VISUALIZATION_KEY)
    private readonly visualizers: IVisualizer[] = [],
  ) {}

  async execute({inputData, requestContext}: WorkflowStepCtx<RenderIn>) {
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

    const visualizer = pickVisualizer(this.visualizers, inputData.chartType);

    emitToolStatus(
      requestContext,
      STEP_RENDER_VISUALIZATION,
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
  }
}

import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {emitToolStatus} from '../../db-query/_helpers';
import {VISUALIZATION_KEY} from '../keys';
import type {IVisualizer, RenderIn} from '../types';
import {pickVisualizer as pickVisualizerShared} from '../shared';
import {VisualizationGraphNodes} from '../nodes.enum';
import {POST_DATASET_TAG} from '../../db-query/keys';

/**
 * Build the chart config via the selected visualizer (the Mastra-named
 * successor of the LangGraph RenderVisualization node). DI-resolved `@step`
 * class.
 */
@graphNode(VisualizationGraphNodes.RenderVisualization, {
  [POST_DATASET_TAG]: true,
})
export class RenderVisualizationNode implements IGraphNode<RenderIn> {
  constructor(
    @inject.tag(VISUALIZATION_KEY)
    private readonly visualizers: IVisualizer[] = [],
  ) {}

  /**
   * Resolve the visualizer for a chart type (falls back to the first when the
   * type is unknown). Overridable seam so a host registering custom chart types
   * can change the fallback policy, then rebind under
   * `@graphNode(VisualizationGraphNodes.RenderVisualization)`.
   */
  protected pickVisualizer(
    visualizers: IVisualizer[],
    chartType: string,
  ): ReturnType<typeof pickVisualizerShared> {
    return pickVisualizerShared(visualizers, chartType);
  }

  async execute({inputData, requestContext}: GraphNodeCtx<RenderIn>) {
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

    const visualizer = this.pickVisualizer(
      this.visualizers,
      inputData.chartType,
    );

    emitToolStatus(
      requestContext,
      VisualizationGraphNodes.RenderVisualization,
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

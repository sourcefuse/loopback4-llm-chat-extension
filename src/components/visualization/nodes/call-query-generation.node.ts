import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {VISUALIZATION_KEY} from '../keys';
import type {CallQueryIn, IVisualizer} from '../types';
import {
  asRecord,
  extractWorkflowResult,
  pickVisualizer as pickVisualizerShared,
  readString,
} from '../shared';
import {VisualizationGraphNodes} from '../nodes.enum';
import {DbQueryNodes} from '../../db-query/nodes.enum';
import {POST_DATASET_TAG} from '../../db-query/keys';

/**
 * Generate (or reuse) the dataset to chart (the Mastra-named successor of the
 * LangGraph CallQueryGeneration node). Invokes the nested generateQueryGraph
 * via the `mastra` instance on the step ctx. DI-resolved `@step` class.
 */
@graphNode(VisualizationGraphNodes.CallQueryGeneration, {
  [POST_DATASET_TAG]: true,
})
export class CallQueryGenerationNode implements IGraphNode<CallQueryIn> {
  constructor(
    @inject.tag(VISUALIZATION_KEY)
    private readonly visualizers: IVisualizer[] = [],
  ) {}

  /**
   * Resolve the visualizer for a chart type (falls back to the first when the
   * type is unknown). Overridable seam so a host registering custom chart types
   * can change the fallback policy, then rebind under
   * `@graphNode(VisualizationGraphNodes.CallQueryGeneration)`.
   */
  protected pickVisualizer(
    visualizers: IVisualizer[],
    chartType: string,
  ): ReturnType<typeof pickVisualizerShared> {
    return pickVisualizerShared(visualizers, chartType);
  }

  async execute({
    inputData,
    mastra,
    requestContext,
  }: GraphNodeCtx<CallQueryIn>) {
    // The selection step rejected every visualizer — short-circuit: do NOT
    // generate a query for a chart we won't render.
    if (inputData.rejected) {
      return {
        datasetId: '',
        needsQuery: false,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
        rejected: true,
        reason: inputData.reason,
      };
    }

    if (inputData.datasetId) {
      return {
        datasetId: inputData.datasetId,
        needsQuery: false,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
      };
    }

    const generate = mastra?.getWorkflow?.('generateQueryGraph');
    if (!generate) {
      return {
        datasetId: '',
        needsQuery: true,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
      };
    }

    // Feed the selected visualizer's data requirements into query generation
    // (v2 call-query-generation.node) so the SQL produces a column shape the
    // chart can actually render — e.g. a pie chart needs a label + value
    // column, a line chart needs an x/y/series triple.
    const visualizer = this.pickVisualizer(
      this.visualizers,
      inputData.chartType,
    );
    const contextClause = visualizer?.context
      ? ` Ensure that the query structure satisfies the following context: ${visualizer.context}`
      : '';

    const run = await generate.createRun();
    const result = await run.start({
      inputData: {
        prompt: `Generate a query to fetch data for visualization based on the following user prompt: ${inputData.userQuery}.${contextClause}`,
      },
      requestContext,
    });

    // Guard on status before extracting the result — if the nested workflow
    // failed/suspended/etc., reject so render() surfaces a reason instead of
    // emitting a silent empty chart (the data fetch would return 0 rows and the
    // visualizer would throw, which render() swallows).
    if (result.status !== 'success') {
      return this.rejectNoData(inputData);
    }

    const rawOut = extractWorkflowResult(result);
    const saveDatasetOut = asRecord(rawOut[DbQueryNodes.SaveDataset]);
    const datasetId = readString(saveDatasetOut.datasetId ?? rawOut.datasetId);

    // Workflow succeeded but produced no dataset (the unanswerable / failed
    // branch). Carry its user-facing reason through instead of an empty chart.
    if (!datasetId) {
      const failedOut = asRecord(rawOut[DbQueryNodes.Failed]);
      const reason = readString(
        saveDatasetOut.replyToUser ??
          failedOut.replyToUser ??
          rawOut.replyToUser,
      );
      return this.rejectNoData(inputData, reason);
    }

    return {
      datasetId,
      needsQuery: false,
      chartType: inputData.chartType,
      userQuery: inputData.userQuery,
    };
  }

  /**
   * The nested query workflow could not produce a chartable dataset. Emit a
   * `rejected` result (carried through get-dataset-data to render) so the user
   * gets the reason rather than a silently empty chart.
   */
  private rejectNoData(inputData: CallQueryIn, reason?: string) {
    return {
      datasetId: '',
      needsQuery: false,
      chartType: inputData.chartType,
      userQuery: inputData.userQuery,
      rejected: true,
      reason:
        reason ??
        'Could not generate the data needed for this visualization. Please rephrase your request.',
    };
  }
}

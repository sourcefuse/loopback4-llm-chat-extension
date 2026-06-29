import {inject} from '@loopback/core';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {VISUALIZATION_KEY} from '../keys';
import type {IVisualizer} from '../types';
import {
  asRecord,
  extractWorkflowResult,
  pickVisualizer,
  readString,
  STEP_CALL_QUERY_GENERATION,
} from './shared';

type CallQueryIn = {
  datasetId: string;
  needsQuery: boolean;
  chartType: string;
  userQuery: string;
  rejected?: boolean;
  reason?: string;
};

/**
 * Generate (or reuse) the dataset to chart (the Mastra-named successor of the
 * LangGraph CallQueryGeneration node). Invokes the nested generateQueryWorkflow
 * via the `mastra` instance on the step ctx. DI-resolved `@step` class.
 */
@step(STEP_CALL_QUERY_GENERATION)
export class CallQueryGenerationStep implements IWorkflowStep<CallQueryIn> {
  constructor(
    @inject.tag(VISUALIZATION_KEY)
    private readonly visualizers: IVisualizer[] = [],
  ) {}

  async execute({
    inputData,
    mastra,
    requestContext,
  }: WorkflowStepCtx<CallQueryIn>) {
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

    const generate = mastra?.getWorkflow?.('generateQueryWorkflow');
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
    const visualizer = pickVisualizer(this.visualizers, inputData.chartType);
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
  }
}

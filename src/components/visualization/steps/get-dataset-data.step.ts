import {inject} from '@loopback/core';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../../db-query/keys';
import type {DataSetHelper} from '../../db-query/services';
import {emitToolStatus} from '../../db-query/steps/_helpers';
import type {IDataSetStore} from '../../db-query/types';
import {
  DEFAULT_CHART_TYPE,
  fetchDatasetDescriptor,
  fetchDatasetRows,
  pickFromBranch,
  readString,
  STEP_GET_DATASET_DATA,
} from './shared';

/**
 * Fetch the rows + descriptor to chart (the Mastra-named successor of the
 * LangGraph GetDatasetData node). DI-resolved `@step` class.
 */
@step(STEP_GET_DATASET_DATA)
export class GetDatasetDataStep implements IWorkflowStep {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
    @inject('services.DataSetHelper', {optional: true})
    private readonly dataSetHelper?: DataSetHelper,
  ) {}

  async execute({inputData, requestContext}: WorkflowStepCtx) {
    emitToolStatus(
      requestContext,
      STEP_GET_DATASET_DATA,
      'Preparing visualization',
    );

    const upstream = pickFromBranch(inputData, 'call-query-generation');
    const chartType = readString(upstream.chartType) ?? DEFAULT_CHART_TYPE;
    const userQuery = readString(upstream.userQuery) ?? '';

    // No visualizer fit the request — skip the data fetch and carry the
    // rejection straight through to the render step.
    if (upstream.rejected) {
      return {
        datasetId: '',
        rows: [],
        chartType,
        userQuery,
        rejected: true,
        reason: readString(upstream.reason),
      };
    }

    const datasetId = readString(upstream.datasetId) ?? '';

    // Two independent reads — run concurrently.
    const [descriptor, rows] = await Promise.all([
      fetchDatasetDescriptor(this.datasetStore, datasetId),
      fetchDatasetRows(this.dataSetHelper, datasetId, requestContext),
    ]);
    const {sql, description} = descriptor;

    return {datasetId, rows, chartType, userQuery, sql, description};
  }
}

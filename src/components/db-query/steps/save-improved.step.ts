import {inject} from '@loopback/core';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import type {IDataSetStore} from '../types';
import {STEP_SAVE_IMPROVED} from './constants';

type SaveOut = {datasetId: string; sql: string};

/** Persist the improved SQL (successor of the LangGraph SaveImproved node). */
@step(STEP_SAVE_IMPROVED)
export class SaveImprovedStep implements IWorkflowStep<unknown, SaveOut> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
  ) {}

  async execute({inputData}: WorkflowStepCtx): Promise<SaveOut> {
    const data = inputData as {
      datasetId?: string;
      sql?: string;
      description?: string;
    };

    const failResult = {datasetId: '', sql: ''};
    if (!data.datasetId || !data.sql) return failResult;

    const store = this.datasetStore;
    if (!store) return failResult;

    const patch: {query: string; description?: string} = {query: data.sql};
    if (data.description !== undefined) patch.description = data.description;

    try {
      await store.updateById(data.datasetId, patch);
    } catch {
      return failResult;
    }

    return {datasetId: data.datasetId, sql: data.sql};
  }
}

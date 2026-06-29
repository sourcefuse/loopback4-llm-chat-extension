import {inject} from '@loopback/core';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import type {IDataSetStore} from '../types';
import {idToString} from './_helpers';
import {STEP_RETURN_CACHED} from './constants';

type CachedOut = {kind: 'cached'; datasetId: string; sql: string};

/** Hydrate a cache-hit dataset (successor of the LangGraph ReturnCached node). */
@step(STEP_RETURN_CACHED)
export class ReturnCachedStep implements IWorkflowStep<unknown, CachedOut> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
  ) {}

  async execute({inputData}: WorkflowStepCtx): Promise<CachedOut> {
    const data = inputData as {datasetId?: string};
    const fallback = {
      kind: 'cached' as const,
      datasetId: data.datasetId ?? '',
      sql: '',
    };
    const store = this.datasetStore;
    if (!store || !data.datasetId) return fallback;

    try {
      const dataset = await store.findById(data.datasetId);
      return {
        kind: 'cached' as const,
        datasetId: idToString(dataset.id ?? data.datasetId),
        sql: dataset.query ?? '',
      };
    } catch {
      return fallback;
    }
  }
}

import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import type {IDataSetStore, SaveOut} from '../types';
import {DbQueryNodes} from '../nodes.enum';

/** Persist the improved SQL (successor of the LangGraph SaveImproved node). */
@graphNode(DbQueryNodes.SaveImproved)
export class SaveImprovedNode implements IGraphNode<unknown, SaveOut> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
  ) {}

  async execute({inputData}: GraphNodeCtx): Promise<SaveOut> {
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

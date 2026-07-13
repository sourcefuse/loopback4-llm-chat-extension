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

    // Let a persist failure propagate to the tool (→ Failed status) rather than
    // swallowing it into an empty success — mirrors the generate path
    // (SaveDataSetNode). Silently returning failResult here lost the user's
    // improvement with zero diagnostics.
    await store.updateById(data.datasetId, patch);

    return {datasetId: data.datasetId, sql: data.sql};
  }
}

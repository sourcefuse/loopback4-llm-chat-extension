import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import type {CachedOut, IDataSetStore} from '../types';
import {idToString} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

/** Hydrate a cache-hit dataset (successor of the LangGraph ReturnCached node). */
@graphNode(DbQueryNodes.ReturnCached)
export class ReturnCachedNode implements IGraphNode<unknown, CachedOut> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
  ) {}

  async execute({inputData}: GraphNodeCtx): Promise<CachedOut> {
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

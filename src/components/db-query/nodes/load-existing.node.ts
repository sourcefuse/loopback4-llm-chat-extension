import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {DbQueryAIExtensionBindings} from '../keys';
import type {IDataSetStore, LoadIn} from '../types';
import {DbQueryNodes} from '../nodes.enum';

/** Load the dataset being improved (successor of the LangGraph load step). */
@graphNode(DbQueryNodes.LoadExisting)
export class LoadExistingNode implements IGraphNode<LoadIn> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore?: IDataSetStore,
  ) {}

  async execute({inputData}: GraphNodeCtx<LoadIn>) {
    const base = {
      datasetId: inputData.datasetId,
      prompt: inputData.prompt,
      originalPrompt: undefined as string | undefined,
      originalSql: undefined as string | undefined,
      tables: [] as string[],
      checklist: '',
      attempts: 0,
      loadError: false,
    };

    const store = this.datasetStore;
    if (!store) return {...base, loadError: true};

    try {
      const dataset = await store.findById(inputData.datasetId);
      return {
        ...base,
        originalPrompt: dataset.prompt,
        originalSql: dataset.query,
        tables: dataset.tables ?? [],
        prompt: `${dataset.prompt}\n also consider following feedback given by user -\n ${inputData.prompt}\n`,
      };
    } catch {
      return {...base, loadError: true};
    }
  }
}

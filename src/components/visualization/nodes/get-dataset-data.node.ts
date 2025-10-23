import {inject} from '@loopback/context';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {VisualizationGraphState} from '../state';
import {VisualizationGraphNodes} from '../nodes.enum';
import {
  DbQueryAIExtensionBindings,
  IDataSetStore,
  POST_DATASET_TAG,
} from '../..';

@graphNode(VisualizationGraphNodes.GetDatasetData, {
  [POST_DATASET_TAG]: true,
})
export class GetDatasetDataNode implements IGraphNode<VisualizationGraphState> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
  ) {}

  async execute(
    state: VisualizationGraphState,
    config: RunnableConfig,
  ): Promise<VisualizationGraphState> {
    const dataset = await this.store.findById(state.datasetId);
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Preparing visualization',
      },
    });
    return {
      ...state,
      sql: dataset.query,
      queryDescription: dataset.description,
    };
  }
}

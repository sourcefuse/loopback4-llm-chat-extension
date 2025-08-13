import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {inject} from '@loopback/context';
import {graphNode} from '../../../decorators';
import {IGraphNode} from '../../../graphs';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbQueryState} from '../state';
import {IDataSetStore} from '../types';

@graphNode(DbQueryNodes.IsImprovement)
export class IsImprovementNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
  ) {}

  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    if (state.datasetId) {
      const dataset = await this.store.findById(state.datasetId);
      return {
        ...state,
        sampleSql: dataset.query,
        sampleSqlPrompt: dataset.prompt,
        prompt: `${dataset.prompt}\n also consider following feedback given by user -\n ${state.prompt}\n`,
      };
    }
    return state;
  }
}

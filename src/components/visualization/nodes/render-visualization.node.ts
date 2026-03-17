import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, ToolStatus} from '../../../graphs';
import {VisualizationGraphState} from '../state';
import {VisualizationGraphNodes} from '../nodes.enum';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {POST_DATASET_TAG} from '../../db-query';

@graphNode(VisualizationGraphNodes.RenderVisualization, {
  [POST_DATASET_TAG]: true,
})
export class RenderVisualizationNode implements IGraphNode<VisualizationGraphState> {
  constructor() {}

  async execute(
    state: VisualizationGraphState,
    config: LangGraphRunnableConfig,
  ): Promise<VisualizationGraphState> {
    const visualizer = state.visualizer;
    if (!visualizer || !state.sql || !state.queryDescription) {
      throw new Error('Invalid State');
    }
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: `Configuring ${visualizer.name}`,
      },
    });
    const settings = await visualizer.getConfig(state);

    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: ToolStatus.Completed,
        data: {
          datasetId: state.datasetId,
          visualization: visualizer.name,
          config: settings || {},
        },
      },
    });
    return {
      ...state,
      done: true,
      visualizerConfig: settings || {},
    };
  }
}

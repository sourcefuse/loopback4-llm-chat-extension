import {service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {DbQueryGraph, POST_DATASET_TAG} from '../../db-query';
import {VisualizationGraphNodes} from '../nodes.enum';
import {VisualizationGraphState} from '../state';

@graphNode(VisualizationGraphNodes.CallQueryGeneration, {
  [POST_DATASET_TAG]: true,
})
export class CallQueryGenerationNode implements IGraphNode<VisualizationGraphState> {
  constructor(
    @service(DbQueryGraph)
    private readonly queryPipeline: DbQueryGraph,
  ) {}
  async execute(
    state: VisualizationGraphState,
    config: RunnableConfig,
  ): Promise<VisualizationGraphState> {
    if (state.datasetId) {
      return state;
    }

    const queryGraph = await this.queryPipeline.build();

    const result = await queryGraph.invoke(
      {
        datasetId: state.datasetId,
        directCall: true,
        prompt: `Generate a query to fetch data for visualization based on the following user prompt: ${state.prompt}.${state.visualizer?.context ? ` Ensure that the query structure satisfies the following context: ${state.visualizer.context}` : ''}`,
      },
      config,
    );

    if (!result.datasetId) {
      config.writer?.({
        type: LLMStreamEventType.Error,
        data: {
          status: `Failed to create dataset for visualization: ${result.replyToUser ?? 'Unknown error'}`,
        },
      });
      return {
        ...state,
        error:
          result.replyToUser ?? 'Failed to create dataset for visualization',
      };
    }

    return {
      ...state,
      datasetId: result.datasetId,
    };
  }
}

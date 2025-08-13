import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, ToolStatus} from '../../../graphs';
import {DbQueryNodes} from '../nodes.enum';
import {DbQueryState} from '../state';

@graphNode(DbQueryNodes.Failed)
export class FailedNode implements IGraphNode<DbQueryState> {
  async execute(
    state: DbQueryState,
    config: LangGraphRunnableConfig,
  ): Promise<DbQueryState> {
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: ToolStatus.Failed,
      },
    });
    return {
      ...state,
      replyToUser:
        state.replyToUser ??
        `I am sorry, I was not able to generate a valid SQL query for your request. Please try again with a more detailed or a more specific prompt.\n` +
          `These were the errors I encountered:\n${state.feedbacks?.join('\n') ?? 'No errors reported.'}`,
    };
  }
}

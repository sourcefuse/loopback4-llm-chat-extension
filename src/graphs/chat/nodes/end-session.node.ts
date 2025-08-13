import {service} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {ChatStore} from '..';
import {graphNode} from '../../../decorators';
import {TokenCounter} from '../../../services';
import {LLMStreamEventType} from '../../event.types';
import {ChatState} from '../../state';
import {IGraphNode, RunnableConfig} from '../../types';
import {ChatNodes} from '../nodes.enum';
const debug = require('debug')('ai-integration:chat:end-session.node');
@graphNode(ChatNodes.EndSession)
export class EndSessionNode implements IGraphNode<ChatState> {
  constructor(
    @service(ChatStore)
    private readonly chatStore: ChatStore,
    @service(TokenCounter)
    private readonly tokenCounter: TokenCounter,
  ) {}
  async execute(state: ChatState, config: RunnableConfig): Promise<ChatState> {
    const tokenCounts = this.tokenCounter.getCounts();
    config.writer?.({
      type: LLMStreamEventType.TokenCount,
      data: {
        inputTokens: tokenCounts.inputs,
        outputTokens: tokenCounts.outputs,
      },
    });
    if (!state.id) {
      // If the chat ID is not defined, we cannot proceed with the session end.
      debug('No chat ID found in state, this is unexpected');
      throw new HttpErrors.InternalServerError();
    }
    await this.chatStore.updateCounts(
      state.id,
      tokenCounts.inputs,
      tokenCounts.outputs,
    );
    // This node is used to end the session, so we can return the state as is.
    // You might want to add any cleanup logic here if needed.
    return state;
  }
}

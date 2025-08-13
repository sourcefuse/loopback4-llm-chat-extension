import {trimMessages} from '@langchain/core/messages';
import {inject} from '@loopback/core';
import {DEFAULT_MAX_TOKEN_COUNT} from '../../../constant';
import {graphNode} from '../../../decorators';
import {AiIntegrationBindings} from '../../../keys';
import {AIIntegrationConfig} from '../../../types';
import {approxTokenCounter} from '../../../utils';
import {LLMStreamEventType} from '../../event.types';
import {ChatState} from '../../state';
import {IGraphNode, RunnableConfig} from '../../types';
import {ChatNodes} from '../nodes.enum';

@graphNode(ChatNodes.TrimMessages)
export class ContextCompressionNode implements IGraphNode<ChatState> {
  constructor(
    @inject(AiIntegrationBindings.Config)
    private readonly config: AIIntegrationConfig,
  ) {}

  async execute(state: ChatState, config: RunnableConfig): Promise<ChatState> {
    const maxTokenCount = +(
      this.config.maxTokenCount ??
      process.env.MAX_TOKEN_COUNT ??
      DEFAULT_MAX_TOKEN_COUNT
    );
    const tokenCount = state.messages.reduce(
      (count, message) => count + approxTokenCounter(message.content),
      0,
    );

    if (tokenCount > maxTokenCount) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Token count ${tokenCount} exceeds limit ${maxTokenCount}. Compressing context.`,
      });
      const trimmed = await trimMessages(state.messages, {
        maxTokens: maxTokenCount,
        strategy: 'last',
        tokenCounter: approxTokenCounter,
        includeSystem: true,
      });
      return {
        ...state,
        messages: trimmed,
      };
    }

    return state;
  }
}

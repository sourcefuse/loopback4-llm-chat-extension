import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {Message} from '../../../models';
import {LLMStreamEventType} from '../../event.types';
import {ChatState} from '../../state';
import {IGraphNode} from '../../types';
import {ChatStore} from '../chat.store';
import {ChatNodes} from '../nodes.enum';
const debug = require('debug')('ai-integration:chat:init-session.node');
@graphNode(ChatNodes.InitSession)
export class InitSessionNode implements IGraphNode<ChatState> {
  constructor(
    @service(ChatStore)
    private readonly chatStore: ChatStore,
  ) {}
  async execute(
    state: ChatState,
    config: LangGraphRunnableConfig,
  ): Promise<ChatState> {
    const chat = await this.chatStore.init(state.prompt, state.id);
    if (!state.id) {
      debug(`New session created with ID: ${chat.id}`);
      config.writer?.({
        type: LLMStreamEventType.Init,
        data: {
          sessionId: chat.id,
        },
      });
    }
    const userMessage = new HumanMessage({
      content: state.prompt,
    });
    const savedUserMessage = await this.chatStore.addHumanMessage(
      chat.id,
      userMessage,
    );
    return {
      ...state,
      id: chat.id,
      userMessage: savedUserMessage,
      messages: [
        new SystemMessage({
          content: `You are a helpful AI assistant. You will answer the user's query by either using the available tools or by denying the request if you don't have a tool available for. You should not answer any questions that can not be answered with any of the available tools.
          If you are not sure about the result, you can ask the user to review the result and provide feedback.
          If the user provides feedback, you can use that feedback to improve the result.
          Do not hallucinate details or make up information.
          Do not use technical jargon in the response, show any internal IDs, or implementation details to the user.`,
        }),
        ...(await this._formatMessage(chat.messages)),
      ],
    };
  }

  private async _formatMessage(messages: Message[]): Promise<BaseMessage[]> {
    if (!messages) {
      return [];
    }
    const graphMessages = await Promise.all(
      messages.map(message => this.chatStore.toMessage(message)),
    );
    return graphMessages.filter(
      (message): message is BaseMessage => message !== undefined,
    );
  }
}

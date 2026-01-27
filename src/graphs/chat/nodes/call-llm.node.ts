import {AIMessage} from '@langchain/core/messages';
import {inject} from '@loopback/context';
import {service} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {graphNode} from '../../../decorators';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider, ToolStore} from '../../../types';
import {getTextContent} from '../../../utils';
import {LLMStreamEventType} from '../../event.types';
import {ChatState} from '../../state';
import {IGraphNode, RunnableConfig} from '../../types';
import {ChatStore} from '../chat.store';
import {ChatNodes} from '../nodes.enum';

const debug = require('debug')('ai-integration:chat:call-llm.node');

@graphNode(ChatNodes.CallLLM)
export class CallLLMNode implements IGraphNode<ChatState> {
  constructor(
    @inject(AiIntegrationBindings.ChatLLM)
    private readonly llm: LLMProvider,
    @inject(AiIntegrationBindings.Tools)
    private readonly tools: ToolStore,
    @service(ChatStore)
    private readonly chatStore: ChatStore,
  ) {}

  async execute(state: ChatState, config: RunnableConfig): Promise<ChatState> {
    const tools = await Promise.all(
      this.tools.list.map(tool => tool.build(config)),
    );
    debug(
      'Calling LLM with tools:',
      tools.map(tool => tool.name),
    );
    const response: AIMessage = await this.llm
      .bindTools(tools)
      .invoke(state.messages);
    const text = getTextContent(response.content).trim();
    if (!state.id) {
      debug('No chat ID found in state, this is unexpected');
      throw new HttpErrors.InternalServerError();
    }
    const aiMessage = await this.chatStore.addAIMessage(state.id, response);

    if (text) {
      config.writer?.({
        type: LLMStreamEventType.Message,
        data: {
          message: getTextContent(response.content),
        },
      });
    }

    return {...state, messages: [response], aiMessage};
  }
}

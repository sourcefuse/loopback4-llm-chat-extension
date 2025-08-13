import {AIMessage, ToolMessage} from '@langchain/core/messages';
import {inject} from '@loopback/context';
import {service} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {graphNode} from '../../../decorators';
import {AiIntegrationBindings} from '../../../keys';
import {ToolStore} from '../../../types';
import {LLMStreamEventType} from '../../event.types';
import {ChatState} from '../../state';
import {IGraphNode, RunnableConfig, ToolStatus} from '../../types';
import {ChatStore} from '../chat.store';
import {ChatNodes} from '../nodes.enum';

const debug = require('debug')('ai-integration:chat:run-tool.node');

@graphNode(ChatNodes.RunTool)
export class RunToolNode implements IGraphNode<ChatState> {
  constructor(
    @inject(AiIntegrationBindings.Tools)
    private readonly tools: ToolStore,
    @service(ChatStore)
    private readonly chatStore: ChatStore,
  ) {}

  async execute(state: ChatState, config: RunnableConfig): Promise<ChatState> {
    if (!state.id) {
      debug('No chat ID found in state, this is unexpected');
      throw new HttpErrors.InternalServerError();
    }
    if (!state.aiMessage) {
      debug('No last AI message found in state, this is unexpected');
      throw new HttpErrors.InternalServerError();
    }
    const newMessages: ToolMessage[] = [];
    const tools = this.tools.map;
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage &
      ToolMessage;
    if (
      !lastMessage ||
      lastMessage.tool_call_id ||
      !lastMessage.tool_calls?.length
    ) {
      return state;
    }
    const toolCalls = lastMessage.tool_calls!;

    for (const toolCall of toolCalls) {
      config.writer?.({
        type: LLMStreamEventType.Tool,
        data: {
          id: toolCall.id,
          tool: toolCall.name,
          data: toolCall.args,
          status: ToolStatus.Running,
        },
      });
      const toolObj = tools[toolCall.name as keyof typeof tools];
      const tool = await toolObj.build(config);
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Running tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.args, undefined, 2)}`,
      });
      const result = await tool.invoke(toolCall.args);

      const output = toolObj.getValue?.(result) ?? result;
      const metadata = toolObj.getMetadata?.(result) ?? {};
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Tool output: ${output}`,
      });
      const toolMessage = new ToolMessage({
        name: toolCall.name,
        content: output,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        tool_call_id: toolCall.id!,
      });

      await this.chatStore.addToolMessage(
        state.id,
        toolMessage,
        metadata,
        state.aiMessage,
        toolCall.args,
      );
      newMessages.push(toolMessage);
    }
    return {...state, messages: newMessages};
  }
}

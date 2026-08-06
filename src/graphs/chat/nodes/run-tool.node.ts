import {inject} from '@loopback/context';
import {service} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {graphNode} from '../../../decorators';
import {AiIntegrationBindings} from '../../../keys';
import {ToolStore} from '../../../types';
import {LLMStreamEventType} from '../../event.types';
import {ChatState} from '../../state';
import {IGraphNode, RunnableConfig, ToolStatus} from '../../types';
import {getToolCalls, ModelMessage, toolResultMessage} from '../../messages';
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
    const newMessages: ModelMessage[] = [];
    const tools = this.tools.map;
    const lastMessage = state.messages[state.messages.length - 1];
    const toolCalls = getToolCalls(lastMessage);
    if (toolCalls.length === 0) {
      return state;
    }

    for (const toolCall of toolCalls) {
      config.writer?.({
        type: LLMStreamEventType.Tool,
        data: {
          id: toolCall.toolCallId,
          tool: toolCall.toolName,
          data: toolCall.input,
          status: ToolStatus.Running,
        },
      });
      const toolObj = tools[toolCall.toolName as keyof typeof tools];
      const tool = await toolObj.build(config);
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Running tool: ${toolCall.toolName} with args: ${JSON.stringify(toolCall.input, undefined, 2)}`,
      });
      const result = await tool.invoke(
        toolCall.input as Record<string, unknown>,
      );

      const output = (toolObj.getValue?.(result) ?? result) as string;
      const metadata = toolObj.getMetadata?.(result) ?? {};
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Tool output: ${output}`,
      });

      await this.chatStore.addToolMessage(
        state.id,
        {
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          content: output,
        },
        metadata,
        state.aiMessage,
        toolCall.input as Record<string, unknown>,
      );
      newMessages.push(
        toolResultMessage(toolCall.toolCallId, toolCall.toolName, output),
      );
    }
    return {...state, messages: newMessages};
  }
}

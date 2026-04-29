import {AIMessage, BaseMessage, ToolMessage} from '@langchain/core/messages';
import {getTextContent} from '../../../utils';
import {MastraAgentMessage, MastraAssistantContentPart} from '../../types';

/**
 * Converts a LangChain `BaseMessage[]` to the `MastraAgentMessage[]` format
 * expected by `IMastraChatAgentRunnable.stream()`.
 *
 * The output shapes are compatible with the AI SDK `CoreMessage` type so
 * real `@mastra/core` Agent instances accept them without further adaptation.
 */
export function toMastraMessages(
  messages: BaseMessage[],
): MastraAgentMessage[] {
  const result: MastraAgentMessage[] = [];
  for (const msg of messages) {
    const type = msg._getType();
    if (type === 'system') {
      result.push({role: 'system', content: getTextContent(msg.content)});
    } else if (type === 'human') {
      result.push({role: 'user', content: getTextContent(msg.content)});
    } else if (type === 'ai') {
      const aiMsg = msg as AIMessage;
      if (aiMsg.tool_calls?.length) {
        const parts: MastraAssistantContentPart[] = [];
        const text = getTextContent(aiMsg.content);
        if (text.trim()) parts.push({type: 'text', text});
        for (const tc of aiMsg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id ?? '',
            toolName: tc.name,
            args: tc.args as Record<string, unknown>,
          });
        }
        result.push({role: 'assistant', content: parts});
      } else {
        result.push({
          role: 'assistant',
          content: getTextContent(aiMsg.content),
        });
      }
    } else if (type === 'tool') {
      const toolMsg = msg as ToolMessage;
      result.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: toolMsg.tool_call_id,
            toolName: toolMsg.name ?? '',
            result: toolMsg.content,
          },
        ],
      });
    }
    // Other message types are dropped — not used in this flow
  }
  return result;
}

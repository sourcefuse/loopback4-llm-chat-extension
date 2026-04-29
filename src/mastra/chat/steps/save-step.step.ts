import {AIMessage, ToolMessage} from '@langchain/core/messages';
import {ChatStore} from '../../../graphs/chat/chat.store';
import {ToolStore} from '../../../types';
import {StepBuffer} from '../types/chat.types';

const debug = require('debug')('ai-integration:mastra:chat-agent');

/**
 * Persists a completed agent step (AI message + tool messages) to the DB.
 *
 * Called at every `step-finish` event in the stream handler.  Steps that
 * contain neither text output nor tool calls are silently skipped.
 *
 * @param chatId    Active chat session identifier.
 * @param step      Buffered data accumulated since the last `step-finish`.
 * @param tools     Tool registry — used to extract display values and metadata.
 * @param chatStore LoopBack chat persistence service.
 */
export async function saveStep(
  chatId: string,
  step: StepBuffer,
  tools: ToolStore,
  chatStore: ChatStore,
): Promise<void> {
  const text = step.textChunks.join('');
  const hasToolCalls = step.toolCalls.length > 0;
  if (!text.trim() && !hasToolCalls) return;

  const aiMsg = new AIMessage({
    content: text || ' ',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    tool_calls: hasToolCalls
      ? step.toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          args: tc.args,
          type: 'tool_call' as const,
        }))
      : [],
  });
  const savedAiMsg = await chatStore.addAIMessage(chatId, aiMsg);

  for (const toolCall of step.toolCalls) {
    const toolResult = step.toolResults.get(toolCall.id);
    if (!toolResult) continue;
    const toolDef = tools.map[toolCall.name];
    if (!toolDef) {
      debug('Unknown tool during save: %s', toolCall.name);
    }
    const output = toolDef?.getValue?.(toolResult.result) ?? toolResult.result;
    const metadata = toolDef?.getMetadata?.(toolResult.result) ?? {};
    const toolMsg = new ToolMessage({
      name: toolCall.name,
      content: String(output),
      // eslint-disable-next-line @typescript-eslint/naming-convention
      tool_call_id: toolCall.id,
    });
    await chatStore.addToolMessage(
      chatId,
      toolMsg,
      metadata,
      savedAiMsg,
      toolCall.args,
    );
  }
}

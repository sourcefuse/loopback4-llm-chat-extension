import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import {ChatStore} from '../../../graphs/chat/chat.store';
import {Message} from '../../../models';

/**
 * Result returned by `initSession`.
 */
export interface InitSessionResult {
  chatId: string;
  baseMessages: BaseMessage[];
  userMessage: Message;
}

/**
 * Mirrors `InitSessionNode`: loads or creates the chat, persists the human
 * message, and rebuilds message history from the DB.
 *
 * @param prompt      The raw user prompt for this turn.
 * @param id          Existing chat ID when continuing a session; undefined for new.
 * @param chatStore   LoopBack chat persistence service.
 * @param systemPrompt Pre-built system prompt string.
 */
export async function initSession(
  prompt: string,
  id: string | undefined,
  chatStore: ChatStore,
  systemPrompt: string,
): Promise<InitSessionResult> {
  const chat = await chatStore.init(prompt, id);
  const savedUserMessage = await chatStore.addHumanMessage(
    chat.id,
    new HumanMessage({content: prompt}),
  );
  const history = await formatHistory(chat.messages ?? [], chatStore);
  const systemMessage = new SystemMessage({content: systemPrompt});
  return {
    chatId: chat.id,
    baseMessages: [systemMessage, ...history],
    userMessage: savedUserMessage,
  };
}

/**
 * Converts DB `Message` rows back to LangChain `BaseMessage` instances.
 * Undefined entries (unsupported message roles) are filtered out.
 */
async function formatHistory(
  dbMessages: Message[],
  chatStore: ChatStore,
): Promise<BaseMessage[]> {
  const converted = await Promise.all(
    dbMessages.map(m => chatStore.toMessage(m)),
  );
  return converted.filter((m): m is BaseMessage => m !== undefined);
}

import {ChatStore, SavedMessage} from '../../../services/chat.store';
import {Message} from '../../../models';
import {MastraAgentMessage} from '../../types';

const debug = require('debug')('ai-integration:mastra:chat:init-session');

/**
 * Result returned by `initSession`.
 */
export interface InitSessionResult {
  chatId: string;
  baseMessages: MastraAgentMessage[];
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
  debug('step start', {id, promptLength: prompt.length});
  const chat = await chatStore.init(prompt, id);
  debug('chat initialised: %s (new=%s)', chat.id, !id);
  const savedUserMessage = await chatStore.addHumanMessage(chat.id, prompt);
  const history = await formatHistory(chat.messages ?? [], chatStore);
  const systemMessage: MastraAgentMessage = {
    role: 'system',
    content: systemPrompt,
  };
  debug('history loaded: %d messages', history.length);
  return {
    chatId: chat.id,
    baseMessages: [systemMessage, ...history],
    userMessage: savedUserMessage,
  };
}

/**
 * Converts DB `Message` rows back to `MastraAgentMessage` instances.
 * Undefined entries (unsupported message roles) are filtered out.
 */
async function formatHistory(
  dbMessages: Message[],
  chatStore: ChatStore,
): Promise<SavedMessage[]> {
  const converted = await Promise.all(
    dbMessages.map(m => chatStore.toMessage(m)),
  );
  return converted.filter((m): m is SavedMessage => m !== undefined);
}

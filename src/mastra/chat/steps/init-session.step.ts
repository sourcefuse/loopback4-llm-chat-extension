import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {ChatStore, SavedMessage} from '../../../services/chat.store';
import {Message} from '../../../models';
import {MastraAgentMessage} from '../../types';

const debug = require('debug')('ai-integration:mastra:chat:init-session');

/**
 * Result returned by `initSessionStep`.
 */
export interface InitSessionResult {
  chatId: string;
  baseMessages: MastraAgentMessage[];
  userMessage: Message;
}

export type InitSessionInput = {
  prompt: string;
  id: string | undefined;
  chatStore: ChatStore;
  systemPrompt: string;
};

/**
 * Plain async function containing the business logic — callable without
 * the Mastra workflow runtime. Used by the workflow DSL directly.
 */
export async function runInitSession(
  params: InitSessionInput,
): Promise<InitSessionResult> {
  const {prompt, id, chatStore, systemPrompt} = params;
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
 * Mirrors `InitSessionNode`: loads or creates the chat, persists the human
 * message, and rebuilds message history from the DB.
 */
export const initSessionStep = createStep({
  id: 'chat-init-session',
  inputSchema: z.any(),
  outputSchema: z.any(),
  execute: async ({
    inputData,
  }: {
    inputData: InitSessionInput;
  }): Promise<InitSessionResult> => {
    return runInitSession(inputData);
  },
});

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

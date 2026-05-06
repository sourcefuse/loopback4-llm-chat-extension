import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {DEFAULT_MAX_TOKEN_COUNT} from '../../../constant';
import {approxTokenCounter} from '../../../utils';
import {MastraAgentMessage} from '../../types';

const debug = require('debug')('mastra:chat:context-compression');

export type ContextCompressionInput = {
  messages: MastraAgentMessage[];
  maxTokenCount: number | undefined;
};

/**
 * Plain async function containing the business logic — callable without
 * the Mastra workflow runtime. Used by the workflow DSL directly.
 */
export async function runCompressContext(
  params: ContextCompressionInput,
): Promise<MastraAgentMessage[]> {
  const {messages, maxTokenCount} = params;
  const limit = +(
    maxTokenCount ??
    process.env.MAX_TOKEN_COUNT ??
    DEFAULT_MAX_TOKEN_COUNT
  );
  const tokenCount = messages.reduce(
    (acc, m) => acc + approxTokenCounter(m.content),
    0,
  );

  debug('Original messages: %d', messages.length);

  if (tokenCount <= limit) {
    return messages;
  }

  debug(
    'Compressing context before agent call: %d tokens > limit %d',
    tokenCount,
    limit,
  );

  // Always keep the system message, then fill remaining budget with the most
  // recent messages (reverse iteration = newest first).
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const systemTokens = systemMessages.reduce(
    (acc, m) => acc + approxTokenCounter(m.content),
    0,
  );
  let remaining = limit - systemTokens;
  const kept: MastraAgentMessage[] = [];

  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    const msg = nonSystemMessages[i];
    const tokens = approxTokenCounter(msg.content);
    if (tokens > remaining) break;
    kept.unshift(msg);
    remaining -= tokens;
  }

  const trimmed = [...systemMessages, ...kept];

  debug('Trimmed messages: %d', trimmed.length);
  debug('Token count: %d', limit - remaining);

  return trimmed;
}

/**
 * Mirrors `ContextCompressionNode`: trims the message list to `maxTokenCount`
 * using a `last` strategy (keeps the most recent messages and always retains
 * the system message).
 *
 * This is a pre-call guard applied once before the agent call.  The Mastra
 * Agent may apply its own internal compression; this prevents oversized
 * initial prompts from being sent at all.
 */
export const compressContextStep = createStep({
  id: 'chat-context-compression',
  inputSchema: z.any(),
  outputSchema: z.any(),
  execute: async ({
    inputData,
  }: {
    inputData: ContextCompressionInput;
  }): Promise<MastraAgentMessage[]> => {
    return runCompressContext(inputData);
  },
});

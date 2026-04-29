import {BaseMessage, trimMessages} from '@langchain/core/messages';
import {DEFAULT_MAX_TOKEN_COUNT} from '../../../constant';
import {approxTokenCounter} from '../../../utils';

const debug = require('debug')('ai-integration:mastra:chat-agent');

/**
 * Mirrors `ContextCompressionNode`: trims the message list to `maxTokenCount`
 * using a `last` strategy (keeps the most recent messages and always retains
 * the system message).
 *
 * This is a pre-call guard applied once before the agent call.  The Mastra
 * Agent may apply its own internal compression; this prevents oversized
 * initial prompts from being sent at all.
 *
 * @param messages      Full message list including the new human message.
 * @param maxTokenCount Token budget from `AIIntegrationConfig`; falls back to
 *                      `MAX_TOKEN_COUNT` env var or the package default.
 */
export async function compressContextIfNeeded(
  messages: BaseMessage[],
  maxTokenCount: number | undefined,
): Promise<BaseMessage[]> {
  const limit = +(
    maxTokenCount ??
    process.env.MAX_TOKEN_COUNT ??
    DEFAULT_MAX_TOKEN_COUNT
  );
  const tokenCount = messages.reduce(
    (acc, m) => acc + approxTokenCounter(m.content),
    0,
  );
  if (tokenCount > limit) {
    debug(
      'Compressing context before agent call: %d tokens > limit %d',
      tokenCount,
      limit,
    );
    return trimMessages(messages, {
      maxTokens: limit,
      strategy: 'last',
      tokenCounter: approxTokenCounter,
      includeSystem: true,
    });
  }
  return messages;
}

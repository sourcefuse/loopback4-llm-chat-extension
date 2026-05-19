import {DEFAULT_MAX_TOKEN_COUNT} from '../../constant';
import {approxTokenCounter} from '../../utils';

/**
 * A message in CoreMessage-compatible format (role + content).
 * We avoid importing directly from Vercel AI SDK to keep the dependency boundary clean;
 * we only use what we need for context trimming.
 */
export type CoreMessageLike = {
  role: string;
  content: string | Array<Record<string, unknown>>;
};

/**
 * ContextWindowManager — manages context compression for the ChatWorkflow.
 *
 * Preserves the exact behaviour of the existing `ContextCompressionNode`:
 *   - strategy: 'last'  (keep the most recent messages when trimming)
 *   - includeSystem: true  (system message always preserved at position 0)
 *   - Approximate token counting (1 token ≈ 4 characters)
 *
 * This is a pure utility class (no LB4 / Mastra dependencies).
 */
export class ContextWindowManager {
  /** Default token budget, mirrors DEFAULT_MAX_TOKEN_COUNT from constants. */
  static readonly DEFAULT_MAX_TOKENS: number = DEFAULT_MAX_TOKEN_COUNT;

  /**
   * Trim a messages array to fit within `maxTokens`.
   *
   * @param messages - Full conversation history (system + prior turns + new turn)
   * @param maxTokens - Token budget (defaults to DEFAULT_MAX_TOKEN_COUNT = 8192)
   * @returns The trimmed messages array, always keeping the system message first.
   */
  static trim(
    messages: CoreMessageLike[],
    maxTokens: number = DEFAULT_MAX_TOKEN_COUNT,
  ): CoreMessageLike[] {
    const totalTokens = messages.reduce(
      (sum, m) => sum + ContextWindowManager._countMessageTokens(m),
      0,
    );

    if (totalTokens <= maxTokens) {
      return messages;
    }

    // Separate system message (always kept) from the rest
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const systemTokens = systemMessages.reduce(
      (sum, m) => sum + ContextWindowManager._countMessageTokens(m),
      0,
    );

    const budget = maxTokens - systemTokens;
    if (budget <= 0) {
      // Even the system message exceeds the budget; return it as-is
      return systemMessages;
    }

    // Keep messages from the END (strategy: 'last')
    const kept: CoreMessageLike[] = [];
    let usedTokens = 0;

    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const msg = nonSystemMessages[i];
      const tokens = ContextWindowManager._countMessageTokens(msg);
      if (usedTokens + tokens > budget) break;
      kept.unshift(msg);
      usedTokens += tokens;
    }

    return [...systemMessages, ...kept];
  }

  /**
   * Return the approximate token count for a single message.
   */
  static countTokens(messages: CoreMessageLike[]): number {
    return messages.reduce(
      (sum, m) => sum + ContextWindowManager._countMessageTokens(m),
      0,
    );
  }

  private static _countMessageTokens(msg: CoreMessageLike): number {
    if (typeof msg.content === 'string') {
      return approxTokenCounter(msg.content);
    }
    if (Array.isArray(msg.content)) {
      return msg.content.reduce((sum, part) => {
        if (typeof part.text === 'string') {
          return sum + approxTokenCounter(part.text);
        }
        return sum;
      }, 0);
    }
    return 0;
  }
}

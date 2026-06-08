import type {InputProcessor} from '@mastra/core/processors';
import {DEFAULT_MAX_TOKEN_COUNT} from '../../constant';
import {approxTokenCounter} from '../../utils';

// MastraDBMessage type lives under @mastra/core/agent/message-list — but we
// only iterate + read content, so type it locally as the minimal subset and
// keep the import surface small. Cast the processor return to never to
// satisfy the wider MastraDBMessage[] signature without re-exporting.
type ChatMessage = {role?: string; content?: unknown};

/**
 * Drop-in for the v2 LangGraph `ContextCompressionNode` — trims the
 * oldest non-system messages when the running token count would exceed
 * the budget. Keeps the chat agent under its provider's context window
 * and mirrors main's behaviour for consumers tuning `MAX_TOKEN_COUNT`.
 *
 * Order of resolution (matches main `context-compression.node.ts`):
 *   1. Constructor-supplied `maxTokenCount` (so consumers can bind
 *      `AIIntegrationConfig.maxTokenCount` straight through)
 *   2. `MAX_TOKEN_COUNT` env var
 *   3. {@link DEFAULT_MAX_TOKEN_COUNT} (8192)
 *
 * Token counting uses the same `approxTokenCounter` (~ 1 token / 4 chars)
 * the rest of the extension uses, so the cutoff matches the legacy node.
 * Strategy: 'last' — drop oldest user/assistant messages first, always
 * keep system messages (Mastra passes those separately via
 * `systemMessages`, so they don't count toward the trimmed array; we
 * still budget for their tokens so the prompt fits).
 *
 * Wire by passing into the `inputProcessors` of the registered chatAgent
 * in Provider. The agent's built-in `MessageHistory` processor
 * already handles persistence; this one trims BEFORE the LLM sees the
 * messages, so memory still stores the un-trimmed history.
 */
export function createMaxTokenCountProcessor(
  opts: {
    maxTokenCount?: number;
  } = {},
): InputProcessor {
  const resolveBudget = (): number => {
    const envValue = process.env.MAX_TOKEN_COUNT;
    return (
      opts.maxTokenCount ??
      (envValue ? Number.parseInt(envValue, 10) : undefined) ??
      DEFAULT_MAX_TOKEN_COUNT
    );
  };

  return {
    id: 'max-token-count',
    name: 'MaxTokenCount',
    description:
      'Trims oldest non-system messages when running token count > MAX_TOKEN_COUNT',
    async processInput({messages, systemMessages}) {
      const budget = resolveBudget();
      if (!Number.isFinite(budget) || budget <= 0) {
        return messages as never;
      }
      const list = messages as unknown as ChatMessage[];
      const systemTokens = sumSystemTokens(systemMessages);
      const remaining = budget - systemTokens;
      if (remaining <= 0) {
        return [] as never;
      }
      const total = sumMessageTokens(list);
      if (total <= remaining) {
        return messages as never;
      }
      const trimmed = trimOldestUntilUnderBudget(list, remaining);
      return trimmed as never;
    },
  };
}

function tokensFor(msg: unknown): number {
  const content = (msg as ChatMessage)?.content;
  if (content === undefined || content === null) return 0;
  // approxTokenCounter accepts LangChain MessageContent which is
  // string | ContentPart[]; cast wide here since Mastra's message shape
  // is structurally similar enough (string or array of {type,text}).
  return approxTokenCounter(content as never);
}

function sumSystemTokens(systemMessages: unknown[]): number {
  return systemMessages.reduce<number>((sum, msg) => sum + tokensFor(msg), 0);
}

function sumMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + tokensFor(msg), 0);
}

function trimOldestUntilUnderBudget(
  messages: ChatMessage[],
  budget: number,
): ChatMessage[] {
  if (messages.length <= 1) return messages;
  const result = [...messages];
  let total = sumMessageTokens(result);
  // Always preserve the last message so the agent has the current turn.
  while (total > budget && result.length > 1) {
    const dropped = result.shift();
    if (!dropped) break;
    total -= tokensFor(dropped);
  }
  return result;
}

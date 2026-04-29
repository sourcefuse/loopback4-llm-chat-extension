import {TokenAccumulator} from '../types/chat.types';

/**
 * Adds per-step token usage into the running accumulator, keyed by model/phase.
 * Mutates `tokens` in place.
 */
export function accumulateUsage(
  usage: {promptTokens?: number; completionTokens?: number},
  modelKey: string,
  tokens: TokenAccumulator,
): void {
  const input = usage.promptTokens ?? 0;
  const output = usage.completionTokens ?? 0;
  tokens.input += input;
  tokens.output += output;
  const prev = tokens.map[modelKey] ?? {inputTokens: 0, outputTokens: 0};
  prev.inputTokens += input;
  prev.outputTokens += output;
  tokens.map[modelKey] = prev;
}

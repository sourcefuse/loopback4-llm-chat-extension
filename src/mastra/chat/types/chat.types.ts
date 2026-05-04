import {LLMStreamEvent} from '../../../types/events';
import {TokenMetadata} from '../../../types';

/**
 * Accumulates token usage across all LLM calls within a single request cycle.
 */
export interface TokenAccumulator {
  input: number;
  output: number;
  map: TokenMetadata;
}

/**
 * Buffers data within a single agent step so we can persist it atomically once
 * the `step-finish` event arrives.
 */
export interface StepBuffer {
  textChunks: string[];
  toolCalls: Array<{id: string; name: string; args: Record<string, unknown>}>;
  toolResults: Map<string, {result: unknown; toolName: string}>;
  /** Buffered `Tool` SSE events — emitted at step-finish after the text bubble. */
  pendingToolEvents: LLMStreamEvent[];
}

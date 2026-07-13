import type {UsageAccumulator} from '../../services/usage-accumulator.service';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {ToolStatus} from '../../graphs/types';

// The SSE bridge for a Mastra `agent.stream()` — drains `fullStream`, maps each
// chunk type to its wire event, coalesces text deltas and captures usage. This
// is Mastra-specific glue with no LangGraph node analog (LangGraph streamed via
// the StateGraph's custom stream mode), so it lives in the runtime bridge, not
// in CallLLMNode. Successor of the old WorkflowRunner pump.

export type AgentStreamChunk = {type: string; payload?: unknown};
export type AgentStreamUsage = {inputTokens?: number; outputTokens?: number};
export type AgentStreamResult = {
  fullStream: AsyncIterable<AgentStreamChunk>;
  usage: Promise<AgentStreamUsage>;
};

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike {
  return typeof value === 'object' && value !== null
    ? (value as RecordLike)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asToolArgs(value: unknown): RecordLike {
  return asRecord(value);
}

/**
 * Safe conversion of any thrown value to a non-empty error message, so the SSE
 * Error event never carries an undefined/empty payload. Shared with ChatGraph's
 * outer catch.
 */
export function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message ?? fallback;
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  return fallback;
}

function toolCallEvent(payload: unknown): LLMStreamEvent {
  const p = asRecord(payload);
  return {
    type: LLMStreamEventType.Tool,
    data: {
      id: readString(p.toolCallId) ?? 'unknown',
      tool: readString(p.toolName) ?? 'unknown',
      data: asToolArgs(p.args),
    },
  };
}

function toolStatusEvent(payload: unknown): LLMStreamEvent {
  const p = asRecord(payload);
  return {
    type: LLMStreamEventType.ToolStatus,
    data: {
      id: readString(p.toolCallId) ?? 'unknown',
      status: ToolStatus.AwaitingApproval,
      data: {toolName: readString(p.toolName), args: p.args},
    },
  };
}

function tripwireEvent(payload: unknown): LLMStreamEvent {
  const p = asRecord(payload);
  return {
    type: LLMStreamEventType.Error,
    data: {
      message: `Blocked by ${readString(p.processorId) ?? 'processor'}: ${readString(p.reason) ?? 'tripwire'}`,
    },
  };
}

function chunkErrorEvent(payload: unknown): LLMStreamEvent {
  const err = asRecord(payload).error;
  return {
    type: LLMStreamEventType.Error,
    data: {message: toErrorMessage(err, 'error')},
  };
}

const CHUNK_MAPPERS: Record<string, (p: unknown) => LLMStreamEvent> = {
  'tool-call': toolCallEvent,
  'tool-call-approval': toolStatusEvent,
  'tool-call-suspended': toolStatusEvent,
  tripwire: tripwireEvent,
  error: chunkErrorEvent,
};

function mapChunkToEvent(chunk: AgentStreamChunk): LLMStreamEvent | undefined {
  const mapper = CHUNK_MAPPERS[chunk.type];
  return mapper ? mapper(chunk.payload) : undefined;
}

export interface PumpOptions {
  /** Emit one Message per text delta (progressive) vs one coalesced Message. */
  streamTokens: boolean;
  /** Records the chat turn's token usage under `usageLabel` when resolved. */
  usage?: UsageAccumulator;
  usageLabel: string;
}

export interface PumpResult {
  /** True once the stream's usage resolved; gates the TokenCount emit. */
  usageReady: boolean;
  /** Raw stream usage — the fallback total when no UsageAccumulator is bound. */
  rawUsage?: {inputTokens: number; outputTokens: number};
}

/**
 * Drain a Mastra `agent.stream()` into the SSE `push` sink. Maps each chunk to
 * its wire event, coalesces (or streams) text deltas, records usage, and
 * surfaces any thrown error as an SSE Error event. Returns the usage outcome for
 * end-session (usage may reject on error/abort → `usageReady:false`).
 */
export async function pumpAgentStream(
  streamPromise: Promise<AgentStreamResult>,
  push: (e: LLMStreamEvent) => void,
  opts: PumpOptions,
): Promise<PumpResult> {
  let buffered = '';
  const flush = () => {
    if (!buffered) return;
    push({type: LLMStreamEventType.Message, data: {message: buffered}});
    buffered = '';
  };
  const handle = (chunk: AgentStreamChunk) => {
    if (chunk.type === 'text-delta') {
      const delta = readString(asRecord(chunk.payload).text) ?? '';
      if (!delta) return;
      if (opts.streamTokens) {
        // Emit immediately — consumers append, producing a progressive reply.
        push({type: LLMStreamEventType.Message, data: {message: delta}});
      } else {
        buffered += delta;
      }
      return;
    }
    if (chunk.type === 'step-start') return;
    if (chunk.type === 'step-finish' || chunk.type === 'finish') {
      flush();
      return;
    }
    flush();
    const event = mapChunkToEvent(chunk);
    if (event) push(event);
  };

  try {
    const stream = await streamPromise;
    for await (const chunk of stream.fullStream) handle(chunk);
    flush();
    return await captureUsage(stream, opts);
  } catch (err) {
    flush();
    push({
      type: LLMStreamEventType.Error,
      data: {message: toErrorMessage(err, 'Unknown error during agent.stream')},
    });
    return {usageReady: false};
  }
}

/**
 * Record the chat turn's usage under its real model id (per-model attribution
 * the limit strategies read) and return the raw usage for the no-accumulator
 * fallback. Usage may reject on error/abort → `usageReady:false` skips
 * TokenCount downstream.
 */
async function captureUsage(
  stream: {usage: Promise<AgentStreamUsage>},
  opts: PumpOptions,
): Promise<PumpResult> {
  try {
    const u = await stream.usage;
    const rawUsage = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
    };
    opts.usage?.add(opts.usageLabel, rawUsage);
    return {usageReady: true, rawUsage};
  } catch {
    return {usageReady: false};
  }
}

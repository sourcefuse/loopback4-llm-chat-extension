import {LLMStreamEvent, LLMStreamEventType} from '../../../types/events';
import {ToolStatus} from '../../../types/tool';
import {ToolStore} from '../../../types';
import {ChatStore} from '../../../services/chat.store';
import {MastraAgentStreamOutput} from '../../types';
import {StepBuffer, TokenAccumulator} from '../types/chat.types';
import {accumulateUsage} from '../utils/token-accumulator.util';
import {safeStringify} from '../utils/safe-json.util';
import {saveStep} from './save-step.step';
import {mastraRequestWriterStore} from '../../request-tool-store';

const debug = require('debug')('ai-integration:mastra:chat-agent');

/**
 * Parameters accepted by `handleStream`.
 */
export interface HandleStreamParams {
  /** Streaming output returned by the Mastra bridge agent. */
  agentStream: MastraAgentStreamOutput;
  /** Forwarded abort signal — aborts the iteration early when fired. */
  abort: AbortSignal;
  /** Tool registry — used for display-value extraction and DB persistence. */
  tools: ToolStore;
  /** Active chat session identifier — used for DB persistence. */
  chatId: string;
  /** LoopBack chat persistence service. */
  chatStore: ChatStore;
  /**
   * Token accumulator shared with the caller.
   * Mutated in place as usage events arrive.
   */
  tokens: TokenAccumulator;
  /**
   * Optional synchronous writer that bypasses the generator and writes
   * tool-internal `ToolStatus` events directly to the SSE transport while the
   * tool is still executing.  When provided, events are written in real time
   * rather than being buffered until `tool-result` fires.
   *
   * The caller is responsible for ensuring the writer is safe to call
   * synchronously (e.g. wrapping `transport.send()` with `void`).
   */
  directWriter?: (event: LLMStreamEvent) => void;
}

function emptyStep(): StepBuffer {
  return {
    textChunks: [],
    toolCalls: [],
    toolResults: new Map(),
  };
}

/**
 * Iterates `agentStream.fullStream`, adapts Mastra events to `LLMStreamEvent`,
 * persists each completed step to the DB, and accumulates token usage.
 *
 * ### Event ordering
 * Text-deltas are buffered and emitted as a single `Message` event at
 * `step-finish`.  This matches LangGraph's behaviour (one `Message` event per
 * LLM generation) so the frontend renders one bubble per step rather than one
 * bubble per SSE chunk.
 *
 * `Tool` (running indicator) events are also buffered until `step-finish` so
 * they appear *after* the preamble text bubble rather than interspersed.
 *
 * `ToolStatus` events emitted by internal tool graphs (e.g. VisualizationGraph)
 * via `config.writer` are captured through `mastraRequestWriterStore` and
 * drained + yielded immediately at `tool-result` time so they arrive in the SSE
 * stream as soon as the tool finishes, not delayed until `step-finish`.
 *
 * `Tool` (running indicator) events are yielded immediately at `tool-call` time
 * (after any preamble text bubble) so the frontend sees the indicator before the
 * tool even starts executing.
 *
 * The generator terminates when:
 *  - the full stream is exhausted, OR
 *  - `abort` is fired.
 */
export async function* handleStream(
  params: HandleStreamParams,
): AsyncGenerator<LLMStreamEvent> {
  const {agentStream, abort, tools, chatId, chatStore, tokens, directWriter} =
    params;

  // Reverse-map: Mastra class name (e.g. 'GetDataAsDatasetTool') → kebab key
  // (e.g. 'get-data-as-dataset') so the `tool` SSE event matches what the
  // frontend expects (the name used when the tool was originally registered).
  const toolClassToKey = new Map<string, string>();
  for (const t of tools.list) {
    const cn = (t as object).constructor?.name;
    if (cn && cn !== t.key) toolClassToKey.set(cn, t.key);
  }

  // ── Tool-internal event routing ───────────────────────────────────────────
  // When `directWriter` is provided, tool-internal ToolStatus events are written
  // directly to the SSE transport during tool execution (real-time).  The
  // writer callback is updated at each `tool-call` to patch in the toolCallId.
  //
  // Without `directWriter`, events fall back to `writerQueue` and are yielded
  // via the generator at `tool-result` time (all at once, after the tool finishes).
  const writerQueue: LLMStreamEvent[] = [];
  // Mutable ref: set to the active toolCallId just before the tool runs so the
  // direct writer can patch events that don't carry an `id`.
  let currentToolCallId: string | undefined;

  mastraRequestWriterStore.set(chatId, (event: LLMStreamEvent) => {
    if (directWriter) {
      // Patch toolCallId into ToolStatus events that don't carry one.
      let ev = event;
      if (
        ev.type === LLMStreamEventType.ToolStatus &&
        !(ev.data as {id?: string}).id &&
        currentToolCallId
      ) {
        ev = {
          ...ev,
          data: {...(ev.data as object), id: currentToolCallId},
        } as LLMStreamEvent;
      }
      directWriter(ev);
    } else {
      writerQueue.push(event);
    }
  });

  let step: StepBuffer = emptyStep();

  try {
    for await (const event of agentStream.fullStream) {
      if (abort.aborted) {
        debug('Stream aborted');
        break;
      }

      // Mastra wraps all event data under `event.payload`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (event as any).payload ?? {};

      switch (event.type) {
        case 'text-delta': {
          const delta = String(p.text ?? '');
          if (delta) {
            step.textChunks.push(delta);
            // Do NOT yield here — accumulate until step-finish so the entire
            // step's text is emitted as one Message event (one bubble).
          }
          break;
        }

        case 'tool-call': {
          const toolCallId = String(p.toolCallId ?? '');
          const toolName = String(p.toolName ?? '');
          // Map class name back to kebab key for frontend compatibility.
          const toolKey = toolClassToKey.get(toolName) ?? toolName;
          const args = (p.args ?? {}) as Record<string, unknown>;
          step.toolCalls.push({id: toolCallId, name: toolName, args});
          debug('Tool call: %s (%s)', toolName, toolCallId);

          // Track current toolCallId so the direct writer can patch events.
          currentToolCallId = toolCallId;

          // Flush any preamble text first so the Message bubble precedes the
          // Tool(Running) indicator.  Clear textChunks so step-finish doesn't
          // re-emit them.
          const preamble = step.textChunks.join('');
          step.textChunks = [];
          if (preamble.trim()) {
            yield {
              type: LLMStreamEventType.Message,
              data: {message: preamble},
            };
          }

          // Emit Tool(Running) immediately — the tool has not started yet, so
          // the frontend receives the indicator before any ToolStatus events.
          yield {
            type: LLMStreamEventType.Tool,
            data: {
              id: toolCallId,
              tool: toolKey,
              data: args,
              status: ToolStatus.Running,
            },
          } as LLMStreamEvent;
          yield {
            type: LLMStreamEventType.Log,
            data: `Running tool: ${toolKey} with args: ${safeStringify(args)}`,
          };
          break;
        }

        case 'tool-result': {
          const toolCallId = String(p.toolCallId ?? '');
          const toolName = String(p.toolName ?? '');
          const result = p.result;
          step.toolResults.set(toolCallId, {result, toolName});
          currentToolCallId = undefined;

          // If directWriter was NOT used, drain the queue and yield events now.
          // (With directWriter, events were already written to the transport.)
          if (!directWriter) {
            const drained = writerQueue.splice(0).map(ev => {
              if (
                ev.type === LLMStreamEventType.ToolStatus &&
                !(ev.data as {id?: string}).id
              ) {
                return {
                  ...ev,
                  data: {...(ev.data as object), id: toolCallId},
                } as LLMStreamEvent;
              }
              return ev;
            });
            for (const ev of drained) {
              yield ev;
            }
          }

          const toolDef = tools.map[toolName];
          if (!toolDef) {
            debug('Unknown tool: %s', toolName);
          }
          const output = toolDef?.getValue?.(result) ?? result;
          debug('Tool result for %s: %j', toolName, output);
          // Log is filtered by SSE transport — no bubble created.
          yield {
            type: LLMStreamEventType.Log,
            data: `Tool output: ${safeStringify(output)}`,
          };
          break;
        }

        case 'step-finish': {
          // 1. Emit text as a single Message bubble, but ONLY when this step
          //    has no tool calls — preamble text before a tool call was already
          //    flushed at `tool-call` time and textChunks was cleared there.
          const text = step.textChunks.join('');
          if (text.trim() && step.toolCalls.length === 0) {
            yield {
              type: LLMStreamEventType.Message,
              data: {message: text},
            };
          }
          // Tool(Running) and ToolStatus events were already yielded eagerly
          // at tool-call / tool-result time respectively.

          // 2. Persist to DB.
          await saveStep(chatId, step, tools, chatStore);

          // 4. Collect per-step token usage.
          const stepUsage = p.output?.usage as
            | {inputTokens?: number; outputTokens?: number}
            | undefined;
          if (stepUsage) {
            accumulateUsage(
              {
                promptTokens: stepUsage.inputTokens,
                completionTokens: stepUsage.outputTokens,
              },
              'mastra-chat',
              tokens,
            );
          }

          step = emptyStep();
          break;
        }

        case 'finish': {
          const finishUsage = p.output?.usage as
            | {inputTokens?: number; outputTokens?: number}
            | undefined;
          if (finishUsage && tokens.input === 0 && tokens.output === 0) {
            accumulateUsage(
              {
                promptTokens: finishUsage.inputTokens,
                completionTokens: finishUsage.outputTokens,
              },
              'mastra-chat',
              tokens,
            );
          }
          break;
        }

        default:
          break;
      }
    }

    // Flush any partial step that didn't receive a `step-finish` event.
    const remainingText = step.textChunks.join('');
    if (remainingText.trim()) {
      yield {type: LLMStreamEventType.Message, data: {message: remainingText}};
    }
    // Tool(Running) / ToolStatus events were already yielded eagerly —
    // nothing left to flush here.
    if (step.textChunks.length || step.toolCalls.length) {
      await saveStep(chatId, step, tools, chatStore);
    }
  } finally {
    // Unregister writer — the agent's finally block also calls delete, but
    // removing it here too ensures cleanup even if iteration is aborted.
    mastraRequestWriterStore.delete(chatId);
  }
}

import {randomUUID} from 'node:crypto';
import debugFactory from 'debug';

const debug = debugFactory('ai-integration:workflow-runner');
import {
  BindingScope,
  Context,
  inject,
  injectable,
  service,
} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {RequestContext} from '@mastra/core/request-context';
import {resolveModelConfig, type MastraModelConfig} from '@mastra/core/llm';
import {generateText, type LanguageModel} from 'ai';
import {AiIntegrationBindings, IRunRegistry} from '../../keys';
import {CHAT_TITLE_MAX_LENGTH} from '../../constant';
import {InternalBindings} from '../internal-bindings';
import {buildChatInstructions} from '../chat-agent-instructions';
import {deriveResourceId, resolvePrincipalId} from '../resource-id.util';
import {upsertChatTokenLedger} from '../chat-token-ledger';
import type {ChatRepository} from '../../repositories';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {ToolStore, ToolStatus} from '../../graphs/types';
import type {Tool} from '@mastra/core/tools';
import {UsageAccumulator} from '../../services/usage-accumulator.service';
import {AsyncEventQueue} from './async-event-queue';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import type {
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
  IQueryTemplateStore,
} from '../../components/db-query/types';
import type {
  DataSetHelper,
  DbSchemaHelperService,
  PermissionHelper,
  TemplateHelper,
} from '../../components/db-query/services';
import type {SchemaStore} from '../../components/db-query/services/schema.store';
import {VISUALIZATION_KEY} from '../../components/visualization/keys';
import type {IVisualizer} from '../../components/visualization/types';
import {AuthenticationBindings} from 'loopback4-authentication';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {
  buildProviderOptions,
  resolveEnvTemperature,
} from '../workflows/db-query/_helpers';
import type {MastraRcShape} from '../workflows/db-query/_helpers';
import {sanitizeFilenameForAwsConverse} from '../../sub-modules/providers/aws/utils';

// Cap the chat agent's tool-calling loop. One data/chart/dataset request
// needs at most: decide-tool → (tool runs) → summarise = ~2-3 LLM steps.
// The old 60 let the model re-call tools and over-reason (double dataset
// generations, chatty multi-step). A tight cap + the focused instructions
// in buildInstructions() keep it a deterministic one-tool pipeline rather
// than a free-roaming assistant. Headroom for an occasional clarify step.
const MAX_AGENT_STEPS = 8;

type RecordLike = Record<string, unknown>;
type ThreadMemory = {
  getThreadById(args: {threadId: string}): Promise<
    | {
        id: string;
        resourceId?: string | null;
        title?: string | null;
        metadata?: Record<string, unknown> | null;
      }
    | null
    | undefined
  >;
  createThread(args: {
    resourceId: string;
    title?: string;
  }): Promise<{id: string}>;
  updateThread?(args: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<unknown>;
};
type ResolvedThread =
  | {threadId: string; resourceId: string; title: string}
  | {error: string};
type AgentStreamChunk = {type: string; payload?: unknown};
type AgentStreamUsage = {inputTokens?: number; outputTokens?: number};
type AgentStreamResult = {
  fullStream: AsyncIterable<AgentStreamChunk>;
  usage: Promise<AgentStreamUsage>;
};

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
 * Safe conversion of any thrown value to a non-empty error message.
 * Used by the pump task's chunk + outer catches so the SSE Error
 * event never carries an undefined / empty payload.
 */
function toErrorMessage(err: unknown, fallback: string): string {
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

/**
 * sourceloop/file-utils' @multipartRequestBody resolves a one-file
 * upload to a single Express.Multer.File object (matching legacy
 * multer.single shape); multi-file uploads land as an array. Normalise
 * so callers only deal with the array case.
 */
type MulterFileInput = Express.Multer.File[] | Express.Multer.File | undefined;

function normaliseFileList(files: MulterFileInput): Express.Multer.File[] {
  if (Array.isArray(files)) return files;
  return files ? [files] : [];
}

function toModelRouterFallbackConfig(
  modelName: string,
): MastraModelConfig | undefined {
  const [providerId, ...modelParts] = modelName.split('/');
  if (!providerId || modelParts.length === 0) return undefined;
  return {providerId, modelId: modelParts.join('/')};
}

function isAiSdkLanguageModel(
  model: unknown,
): model is Exclude<LanguageModel, string> {
  const specVersion = readString(asRecord(model).specificationVersion);
  return specVersion === 'v2' || specVersion === 'v3';
}

/**
 * No file model / chat model bound. Emit a Status per file so the UI
 * knows attachments were received but skipped, then return the
 * un-augmented query rather than crashing the run.
 */
function emitSkipsAndReturn(
  list: Express.Multer.File[],
  query: string,
  push: (e: LLMStreamEvent) => void,
): string {
  for (const file of list) {
    push({
      type: LLMStreamEventType.Status,
      data: `Skipped file ${file.originalname}: no LLM bound for summarisation`,
    });
  }
  return query;
}

const CHUNK_MAPPERS: Record<string, (p: unknown) => LLMStreamEvent> = {
  'tool-call': toolCallEvent,
  'tool-call-approval': toolStatusEvent,
  'tool-call-suspended': toolStatusEvent,
  tripwire: tripwireEvent,
  error: chunkErrorEvent,
};

/**
 * Table-dispatched chunk -> SSE event mapping. Returns undefined for
 * chunk types that need side-effect handling (e.g. 'finish' which has
 * to persist the runId on suspend). Extracted to keep handleChunk
 * under SonarQube's complexity threshold.
 */
function mapChunkToEvent(chunk: {
  type: string;
  payload?: unknown;
}): LLMStreamEvent | undefined {
  const mapper = CHUNK_MAPPERS[chunk.type];
  return mapper ? mapper(chunk.payload) : undefined;
}

/**
 * REQUEST-scoped bridge between LB4 controllers and the singleton Mastra Agent.
 * Replaces v2's ChatGraph.execute(). The single AsyncEventQueue enforces total
 * order across the pre-processing block, the fullStream pump task, and any
 * tool-side eventWriter calls.
 *
 * P1 scope: chat flow + Memory thread management + SSE pump. File summarisation
 * (v2 SummariseFileNode) and live tool wiring are added later in P1.11.
 *
 * Refs: the migration plan.
 */
@injectable({scope: BindingScope.REQUEST})
export class WorkflowRunner {
  private bufferedAssistantText = '';

  // Token streaming. Default OFF: the assistant reply is coalesced into a
  // single terminal `Message` event (the original contract — safe for
  // consumers that treat a `message` event as a full snapshot). Opt in with
  // `MASTRA_STREAM_TOKENS=true` to emit one `Message` per text delta so the
  // UI renders progressively. Consumers must APPEND `message` events when
  // this is on (the bundled sandbox UI already does). v2 LangGraph did not
  // stream tokens — its call-llm node emitted one Message after a blocking
  // invoke — so OFF preserves byte-for-byte parity.
  private readonly streamTokens = process.env.MASTRA_STREAM_TOKENS === 'true';

  constructor(
    @inject.context() private lb4Ctx: Context,
    @inject(InternalBindings.Mastra) private mastra: Mastra,
    @inject(AiIntegrationBindings.ChatLLM, {optional: true})
    private chatLlm?: MastraModelConfig,
    @inject(InternalBindings.RunRegistry)
    private runRegistry?: IRunRegistry,
    @inject(InternalBindings.ResourceId, {optional: true})
    private resourceIdValue?: string,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    private systemContext?: string[],
    @service(UsageAccumulator) private usage?: UsageAccumulator,
    @inject(InternalBindings.Tools, {optional: true})
    private mastraTools?: ToolStore,
    @inject(AiIntegrationBindings.FileLLM, {optional: true})
    private fileLlm?: MastraModelConfig,
    // Tier slots — optional; when unbound, workflow steps fall back to
    // chatLlm via the getCheapLlm/getSmartLlm/getSmartNonThinkingLlm
    // accessors. Bound positions appended at the END so existing test
    // fixtures that pass positional args don't have to be renumbered.
    @inject(AiIntegrationBindings.CheapLLM, {optional: true})
    private cheapLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.SmartLLM, {optional: true})
    private smartLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.SmartNonThinkingLLM, {optional: true})
    private smartNonThinkingLlm?: MastraModelConfig,
  ) {}

  async *run(
    query: string,
    files: Express.Multer.File[] | Express.Multer.File | undefined,
    abort: AbortSignal,
    sessionId?: string,
  ): AsyncIterable<LLMStreamEvent> {
    const queue = new AsyncEventQueue<LLMStreamEvent>({
      overflowValue: {
        type: LLMStreamEventType.Error,
        data: {
          message:
            'SSE event queue overflow: too many events were produced before the client could consume them. The stream was closed early.',
        },
      },
    });
    this.bufferedAssistantText = '';

    // Stream the chatAgent REGISTERED on the Mastra singleton (not a detached
    // `new Agent()`). A registered agent carries the Mastra instance's
    // observability context, so its spans + tool-call spans reach the
    // configured exporter (Langfuse). Per-request model / tools /
    // instructions are resolved by the agent's dynamic params from the
    // RequestContext built below.
    const agent = this.mastra.getAgent('chatAgent');
    if (!agent) {
      queue.push({
        type: LLMStreamEventType.Error,
        data: {
          message:
            'ChatAgent not registered in Mastra — check Provider boot order',
        },
      });
      queue.close();
      yield* queue;
      return;
    }
    const memory = await agent.getMemory();
    if (!memory) {
      queue.push({
        type: LLMStreamEventType.Error,
        data: {message: 'Mastra Memory is required but not configured'},
      });
      queue.close();
      yield* queue;
      return;
    }

    // SECURITY: never share an 'anonymous' bucket — Mastra Memory
    // `scope:'resource'` groups working memory + semantic recall by
    // resourceId. The consumer-bound ResourceId resolver returns
    // `${tenantId}:${userId}` for multi-tenant safety.
    //
    // When resuming an existing thread (sessionId provided) we MUST
    // honour the resourceId that was set when the thread was first
    // created. Falling back to `sessionId` for a resumed thread would
    // diverge from the resourceId the original request used and break
    // Memory.semanticRecall + working memory scope. Load the thread
    // first, then prefer thread.resourceId on resume.
    const requesterResourceId = await this.resolveRequesterResourceId();
    const resolved = await this.resolveThread(
      memory,
      sessionId,
      requesterResourceId,
      id => queue.push({type: LLMStreamEventType.Init, data: {sessionId: id}}),
      query,
    );
    if ('error' in resolved) {
      queue.push({
        type: LLMStreamEventType.Error,
        data: {message: resolved.error},
      });
      queue.close();
      yield* queue;
      return;
    }
    const {threadId, resourceId, title: threadTitle} = resolved;
    // Persist cumulative token usage after the run (best-effort) — mirrors v2
    // main's ChatStore.updateCounts. TWO sinks:
    //   1. Memory thread metadata — makes /chats token counts meaningful.
    //   2. The `chats` ledger row — what the token/chat LIMIT STRATEGIES read.
    //      The Mastra runtime stopped writing chat rows (threads moved to
    //      Memory), so without (2) the chats table is empty and the caps never
    //      fire. Restored here, keyed by threadId to line up with the thread.
    const persistUsage = async (
      inputTokens: number,
      outputTokens: number,
    ): Promise<void> => {
      // The runtime Memory instance has updateThread; the narrowed base type
      // doesn't declare it, so view it through ThreadMemory (updateThread
      // optional + guarded below).
      const tm = memory as unknown as ThreadMemory;
      if (tm.updateThread) {
        try {
          const current = await tm.getThreadById({threadId});
          const md = (current?.metadata as Record<string, unknown>) ?? {};
          await tm.updateThread({
            id: threadId,
            title: current?.title ?? threadTitle,
            metadata: {
              ...md,
              inputTokens: (Number(md.inputTokens) || 0) + inputTokens,
              outputTokens: (Number(md.outputTokens) || 0) + outputTokens,
            },
          });
        } catch (err) {
          debug('persistUsage (thread metadata) skipped: %o', err);
        }
      }
      await this.persistChatLedger(
        threadId,
        threadTitle,
        inputTokens,
        outputTokens,
      );
    };

    // File summarisation — port of v2 SummariseFileNode. For each
    // attached file, ask the ChatLLM to produce
    // a focused summary against the user's prompt, then merge the
    // summary into the query so the chat Agent sees the file content
    // as part of its input. AI SDK file content lives in user-message
    // content arrays as `{type: 'file', data, mediaType}` parts.
    const augmentedQuery = await this.summariseAndMergeFiles(query, files, e =>
      queue.push(e),
    );

    // Bounded service resolution per migration plan Section 3.4
    // ("least-privilege — pass bounded service references, NOT the
    // whole LB4 Context"). Each binding is optional so the workflow
    // stays runnable under partial configuration.
    const rcShape = await this.resolveRequestContextShape({
      resourceId,
      eventWriter: e => queue.push(e),
    });
    const ctx = new RequestContext<MastraRcShape>();
    this.populateRequestContext(ctx, rcShape);

    // Pump fullStream chunks into the queue. The pre-processing block above
    // and any tool-side eventWriter calls push onto the same queue; total
    // order is preserved by sequential push semantics.
    // `providerOptions` carries Anthropic/Bedrock thinking config derived
    // from CLAUDE_THINKING / CLAUDE_THINKING_BUDGET env — preserves the v2
    // LangGraph extension's behaviour where reasoning models honour the
    // same envs. No-op on OpenAI / OpenRouter / Google / Cerebras models.
    const providerOptions = buildProviderOptions();
    const temperature = resolveEnvTemperature();
    const streamPromise: Promise<AgentStreamResult> = agent.stream(
      [{role: 'user', content: augmentedQuery}],
      {
        maxSteps: MAX_AGENT_STEPS,
        abortSignal: abort,
        requestContext: ctx,
        memory: {thread: threadId, resource: resourceId},
        ...(temperature !== undefined ? {temperature} : {}),
        ...(providerOptions ? {providerOptions: providerOptions as never} : {}),
      },
    );

    // Pump task is fire-and-forget; completion is signalled by queue.close()
    // inside the inner finally. The inner try/catch maps any thrown error to
    // an SSE Error event before closing, so this promise never rejects.
    this.pumpStream(streamPromise, queue, persistUsage).catch(err => {
      // pumpStream's inner try/catch maps errors to SSE Error + closes
      // the queue. This guard catches unexpected escapes (e.g. queue
      // push during error-emission). Log instead of swallow.
      debug('pump task escaped error: %o', err);
    });

    yield* queue;
  }

  /**
   * Drain a Mastra `agent.stream()` into the SSE queue. Extracted from
   * run() to keep cyclomatic + cognitive complexity below
   * SonarQube's thresholds. Maps every chunk type to its SSE event,
   * captures usage, and surfaces any thrown error as an SSE Error
   * event before closing the queue.
   */
  private async pumpStream(
    streamPromise: Promise<AgentStreamResult>,
    queue: AsyncEventQueue<LLMStreamEvent>,
    persistUsage?: (inputTokens: number, outputTokens: number) => Promise<void>,
  ): Promise<void> {
    try {
      const stream = await streamPromise;
      for await (const chunk of stream.fullStream) {
        this.handleChunk(chunk, queue);
      }
      this.flushBufferedAssistantText(queue);
      await this.emitUsage(stream, queue, persistUsage);
    } catch (err) {
      this.flushBufferedAssistantText(queue);
      queue.push({
        type: LLMStreamEventType.Error,
        data: {
          message: toErrorMessage(err, 'Unknown error during agent.stream'),
        },
      });
    } finally {
      queue.close();
    }
  }

  private handleChunk(
    chunk: {type: string; payload?: unknown},
    queue: AsyncEventQueue<LLMStreamEvent>,
  ): void {
    if (chunk.type === 'text-delta') {
      const delta = readString(asRecord(chunk.payload).text) ?? '';
      if (!delta) return;
      if (this.streamTokens) {
        // Emit immediately — consumers append, producing a progressive reply.
        queue.push({
          type: LLMStreamEventType.Message,
          data: {message: delta},
        });
      } else {
        this.bufferedAssistantText += delta;
      }
      return;
    }
    if (chunk.type === 'step-start') {
      return;
    }
    if (chunk.type === 'step-finish' || chunk.type === 'finish') {
      this.flushBufferedAssistantText(queue);
      return;
    }
    this.flushBufferedAssistantText(queue);
    const event = mapChunkToEvent(chunk);
    if (event) queue.push(event);
    // 'finish' chunks: nothing to do in P3. HITL resume path
    // (ApprovalController + RunRegistry consumer) lands in v3.1
    // (Phase 4 of the migration plan). Persisting runId without a
    // consumer would accumulate unread TTL entries.
  }

  private flushBufferedAssistantText(
    queue: AsyncEventQueue<LLMStreamEvent>,
  ): void {
    if (!this.bufferedAssistantText) return;
    queue.push({
      type: LLMStreamEventType.Message,
      data: {message: this.bufferedAssistantText},
    });
    this.bufferedAssistantText = '';
  }

  private async emitUsage(
    stream: {
      usage: Promise<{inputTokens?: number; outputTokens?: number}>;
    },
    queue: AsyncEventQueue<LLMStreamEvent>,
    persistUsage?: (inputTokens: number, outputTokens: number) => Promise<void>,
  ): Promise<void> {
    try {
      const u = await stream.usage;
      const inputTokens = u.inputTokens ?? 0;
      const outputTokens = u.outputTokens ?? 0;
      this.usage?.add('chat-llm', {inputTokens, outputTokens});
      queue.push({
        type: LLMStreamEventType.TokenCount,
        data: {inputTokens, outputTokens},
      });
      await persistUsage?.(inputTokens, outputTokens);
    } catch {
      // usage may reject on error / abort paths; skip TokenCount
    }
  }

  /**
   * Port of v2 SummariseFileNode. For each attached file, run a single
   * ChatLLM call summarising the file against the user's prompt, then
   * merge the summary into the query so the chat Agent sees the file
   * content as part of its input. Emits a Status event per file so the
   * UI can show progress, matching the v2 SSE contract.
   */
  private async summariseAndMergeFiles(
    query: string,
    files: Express.Multer.File[] | Express.Multer.File | undefined,
    push: (e: LLMStreamEvent) => void,
  ): Promise<string> {
    const list = normaliseFileList(files);
    if (!list.length) return query;
    const modelConfig = this.resolveFileSummaryModelConfig();
    if (!modelConfig) return emitSkipsAndReturn(list, query, push);
    const model = await this.resolveAiLanguageModel(modelConfig);
    if (!model) return emitSkipsAndReturn(list, query, push);
    const summaries: string[] = [];
    for (const file of list) {
      const summary = await this.summariseFile(query, file, model, push);
      if (summary) summaries.push(summary);
    }
    if (!summaries.length) return query;
    return `${query}\n\n${summaries.join('\n\n')}`;
  }

  private async summariseFile(
    query: string,
    file: Express.Multer.File,
    model: Exclude<LanguageModel, string>,
    push: (e: LLMStreamEvent) => void,
  ): Promise<string | undefined> {
    push({
      type: LLMStreamEventType.Status,
      data: `Reading file: ${file.originalname}`,
    });
    const providerOptions = buildProviderOptions();
    const temperature = resolveEnvTemperature();
    try {
      const result = await generateText({
        model,
        ...(temperature !== undefined ? {temperature} : {}),
        messages: [
          {
            role: 'system',
            content:
              'Summarise the attached file with the user prompt in mind. ' +
              'Keep important details that may answer the user query. ' +
              'Return plain text only — no markdown, no preamble.',
          },
          {
            role: 'user',
            content: [
              {type: 'text', text: query},
              {
                type: 'file',
                data: file.buffer ?? Buffer.alloc(0),
                mediaType: file.mimetype || 'application/pdf',
                // Bedrock Converse rejects document names with disallowed
                // characters / consecutive whitespace; sanitise so Bedrock
                // file uploads work (restores v2 getFile() behaviour). Other
                // providers ignore / accept the filename.
                filename: sanitizeFilenameForAwsConverse(file.originalname),
              },
            ],
          },
        ],
        ...(providerOptions ? {providerOptions: providerOptions as never} : {}),
      });
      return `[Attached file "${file.originalname}"]\n${result.text.trim()}`;
    } catch (err) {
      debug('file summarisation failed for %s: %o', file.originalname, err);
      push({
        type: LLMStreamEventType.Status,
        data: `Failed to read file: ${file.originalname}`,
      });
      return undefined;
    }
  }

  private resolveFileSummaryModelConfig(): MastraModelConfig | undefined {
    // fileLlm FIRST — consumers bind a vision/file-capable model there specifically
    // for file summarisation. chatLlm is the fallback when no dedicated file model
    // is bound (the v2 behaviour: SummariseFileNode used FileLLM with chatLlm fallback).
    if (this.fileLlm) return this.fileLlm;
    if (this.chatLlm) return this.chatLlm;
    const defaultModel = process.env.MASTRA_DEFAULT_CHAT_MODEL;
    return defaultModel ? toModelRouterFallbackConfig(defaultModel) : undefined;
  }

  private async resolveAiLanguageModel(
    modelConfig: MastraModelConfig,
  ): Promise<Exclude<LanguageModel, string> | undefined> {
    const mastraForResolve =
      typeof asRecord(this.mastra).listGateways === 'function'
        ? this.mastra
        : undefined;
    const model = await resolveModelConfig(
      modelConfig,
      undefined,
      mastraForResolve,
    );
    return isAiSdkLanguageModel(model) ? model : undefined;
  }

  private async resolveChatLlmModel(): Promise<
    Exclude<LanguageModel, string> | undefined
  > {
    if (!this.chatLlm) return undefined;
    return this.resolveAiLanguageModel(this.chatLlm);
  }

  /**
   * Resolve an optional tier slot (cheap/smart/smartNonThinking) to a
   * concrete AI-SDK model so workflow steps' `tracedGenerateText` can call
   * `generateText` directly. Returns undefined when the slot is unbound;
   * the _helpers accessors then fall back to the resolved chat model.
   */
  private async resolveTierModel(
    cfg?: MastraModelConfig,
  ): Promise<Exclude<LanguageModel, string> | undefined> {
    if (!cfg) return undefined;
    return this.resolveAiLanguageModel(cfg);
  }

  private buildToolMap(): Record<string, Tool> {
    if (!this.mastraTools) return {};
    return Object.fromEntries(
      this.mastraTools.list.map(t => [t.key, t.build()]),
    );
  }

  private buildInstructions(): string {
    // Shares CHAT_AGENT_DIRECTIVES with the registered-agent fallback so the
    // two cannot drift. The previous bespoke wording here ("only reply
    // conversationally when no tool fits") let gemini-class models narrate
    // instead of calling the query tool — the "LLM did not call the query
    // tool" routing miss. The shared forceful "MUST call the closest tool"
    // wording suppresses it.
    //
    // `Current date is …` restores v2 init-session.node: without it the agent
    // has no notion of "today", so relative-time questions ("joined last
    // month", "this year", "latest") resolve against the model's stale
    // training cutoff. buildChatInstructions computes it per request and
    // appends the host `systemContext` last (v2 order: directives, date,
    // context).
    return buildChatInstructions(this.systemContext);
  }

  /**
   * Write the per-session token-usage row the limit strategies read (restores
   * v2 ChatStore bookkeeping). Resolves ChatRepository + the authenticated user
   * from the request context — both optional, so a consumer without the chats
   * table simply skips. Keyed by threadId; userId uses the same principal
   * (userTenantId) as the resourceId so ownership filters line up. Best-effort.
   */
  private async persistChatLedger(
    threadId: string,
    title: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    try {
      const repo = await this.lb4Ctx.get<ChatRepository>(
        'repositories.ChatRepository',
        {optional: true},
      );
      const user = await this.lb4Ctx.get<IAuthUserWithPermissions>(
        AuthenticationBindings.CURRENT_USER,
        {optional: true},
      );
      const principal = resolvePrincipalId(user);
      if (!repo || !user?.tenantId || !principal) return;
      await upsertChatTokenLedger(
        repo,
        {id: threadId, tenantId: user.tenantId, userId: principal, title},
        inputTokens,
        outputTokens,
      );
    } catch (err) {
      debug('persistChatLedger skipped: %o', err);
    }
  }

  /**
   * Resolve every binding workflow steps may read from RequestContext.
   * The set is fixed + bounded (least-privilege per migration plan
   * Section 3.4). Each lookup is `{optional: true}` so deployments that
   * mount AiIntegrationsComponent without the DbQuery / Visualizer
   * sub-components still get a runnable RequestContext.
   */
  private async resolveRequestContextShape(args: {
    resourceId: string;
    eventWriter: (event: LLMStreamEvent) => void;
  }): Promise<MastraRcShape> {
    const opt = {optional: true} as const;
    const [
      dbConnector,
      authUser,
      datasetStore,
      templateStore,
      schemaStore,
      schemaHelper,
      templateHelper,
      dataSetHelper,
      permissionHelper,
      queryCache,
      templateCache,
      globalContext,
      config,
      chatLlm,
      cheapLlm,
      smartLlm,
      smartNonThinkingLlm,
    ] = await Promise.all([
      this.lb4Ctx.get<IDbConnector>(DbQueryAIExtensionBindings.Connector, opt),
      this.lb4Ctx.get<IAuthUserWithPermissions>(
        AuthenticationBindings.CURRENT_USER,
        opt,
      ),
      this.lb4Ctx.get<IDataSetStore>(
        DbQueryAIExtensionBindings.DatasetStore,
        opt,
      ),
      this.lb4Ctx.get<IQueryTemplateStore>(
        DbQueryAIExtensionBindings.TemplateStore,
        opt,
      ),
      this.lb4Ctx.get<SchemaStore>('services.SchemaStore', opt),
      this.lb4Ctx.get<DbSchemaHelperService>(
        'services.DbSchemaHelperService',
        opt,
      ),
      this.lb4Ctx.get<TemplateHelper>('services.TemplateHelper', opt),
      this.lb4Ctx.get<DataSetHelper>('services.DataSetHelper', opt),
      this.lb4Ctx.get<PermissionHelper>('services.PermissionHelper', opt),
      this.lb4Ctx.get<MastraRcShape['queryCache']>(
        DbQueryAIExtensionBindings.QueryCache,
        opt,
      ),
      this.lb4Ctx.get<MastraRcShape['templateCache']>(
        DbQueryAIExtensionBindings.TemplateCache,
        opt,
      ),
      this.lb4Ctx.get<string[]>(DbQueryAIExtensionBindings.GlobalContext, opt),
      this.lb4Ctx.get<DbQueryConfig>(DbQueryAIExtensionBindings.Config, opt),
      this.resolveChatLlmModel(),
      this.resolveTierModel(this.cheapLlm),
      this.resolveTierModel(this.smartLlm),
      this.resolveTierModel(this.smartNonThinkingLlm),
    ]);
    const visBindings = this.lb4Ctx.findByTag({[VISUALIZATION_KEY]: true});
    const visualizers = await Promise.all(
      visBindings.map(b => this.lb4Ctx.get<IVisualizer>(b.key)),
    );
    return {
      resourceId: args.resourceId,
      eventWriter: args.eventWriter,
      chatLlm,
      cheapLlm,
      smartLlm,
      smartNonThinkingLlm,
      // Per-request chat-agent config consumed by the registered chatAgent's
      // dynamic params (model/tools/instructions resolve from these). model
      // falls back to MASTRA_DEFAULT_CHAT_MODEL inside the agent when chatLlm
      // is unbound — fail-closed is enforced at Provider boot.
      agentModel: this.chatLlm,
      agentTools: this.buildToolMap(),
      agentInstructions: this.buildInstructions(),
      globalContext,
      dbConnector,
      authUser,
      datasetStore,
      config,
      templateStore,
      schemaStore,
      schemaHelper,
      templateHelper,
      dataSetHelper,
      permissionHelper,
      queryCache,
      templateCache,
      visualizers,
    };
  }

  /**
   * Tenant-scoped requester identity used to (a) stamp newly-created
   * threads and (b) authorize resume of existing ones. Prefers an
   * explicitly bound `InternalBindings.ResourceId`; otherwise derives
   * `${tenantId}:${principalId}` from the authenticated user. Returns
   * undefined when neither is resolvable so callers can refuse rather than
   * resume into the wrong scope.
   */
  /**
   * Resolve the Memory thread for this run. On a fresh request (no
   * sessionId) creates a thread stamped with the requester identity and
   * emits Init. On resume, loads the thread and enforces: it exists, it
   * carries a resourceId, the requester identity is resolvable, and it
   * matches the thread's owner. Returns {error} for any failure so run()
   * stays flat (one error-emit site) and under SonarQube's complexity cap.
   */
  private async resolveThread(
    memory: ThreadMemory,
    sessionId: string | undefined,
    requesterResourceId: string | undefined,
    emitInit: (sessionId: string) => void,
    prompt?: string,
  ): Promise<ResolvedThread> {
    if (!sessionId) {
      const resourceId = requesterResourceId ?? randomUUID();
      // Stamp the thread with a title from the first prompt (truncated),
      // mirroring v2 main's ChatStore.init (`prompt.slice(0, 200)`). Without
      // this, threads have no title and the chat-history list shows blanks —
      // Mastra only auto-titles when MASTRA_GENERATE_TITLE is on (an extra LLM
      // call). A prompt-derived title is free and matches main's behaviour.
      const trimmed = prompt?.trim().slice(0, CHAT_TITLE_MAX_LENGTH);
      // ternary (not ??) so an empty prompt yields undefined, not '' — and
      // not `||` which trips @typescript-eslint/prefer-nullish-coalescing.
      const title = trimmed ? trimmed : undefined;
      const thread = await memory.createThread({resourceId, title});
      emitInit(thread.id);
      return {threadId: thread.id, resourceId, title: title ?? ''};
    }
    const thread = await memory.getThreadById({threadId: sessionId});
    if (!thread) return {error: `Thread ${sessionId} not found`};
    // A missing resourceId is an upstream invariant violation (corruption /
    // manual DB edit). Papering over it with a fresh UUID would orphan the
    // thread's Memory scope, so refuse.
    if (!thread.resourceId) {
      return {
        error:
          `Thread ${sessionId} is missing resourceId — possible data ` +
          `corruption. Refusing to resume to avoid orphaning the conversation.`,
      };
    }
    // SECURITY: a thread may only be resumed by the same tenant-scoped
    // requester that created it. No resolvable identity → cannot prove
    // ownership → refuse rather than leak another tenant's conversation.
    if (!requesterResourceId) {
      return {
        error:
          'Unable to authorize thread resume: requester resource identity ' +
          'is unavailable. Ensure an authenticated user with tenantId + id is present, ' +
          'or bind InternalBindings.ResourceId.',
      };
    }
    if (thread.resourceId !== requesterResourceId) {
      return {
        error: `Thread ${sessionId} does not belong to the authenticated requester`,
      };
    }
    return {
      threadId: thread.id,
      resourceId: thread.resourceId,
      title: thread.title ?? '',
    };
  }

  private async resolveRequesterResourceId(): Promise<string | undefined> {
    const user = await this.lb4Ctx.get<IAuthUserWithPermissions>(
      AuthenticationBindings.CURRENT_USER,
      {optional: true},
    );
    return deriveResourceId(user, this.resourceIdValue);
  }

  private populateRequestContext(
    ctx: RequestContext<MastraRcShape>,
    values: MastraRcShape,
  ): void {
    for (const key of Object.keys(values) as Array<keyof MastraRcShape>) {
      const value = values[key];
      if (value !== undefined) {
        ctx.set(key, value);
      }
    }
  }
}

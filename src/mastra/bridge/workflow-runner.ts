import {randomUUID} from 'crypto';
import {
  BindingScope,
  Context,
  inject,
  injectable,
  service,
} from '@loopback/core';
import {Agent} from '@mastra/core/agent';
import {Mastra} from '@mastra/core';
import {RequestContext} from '@mastra/core/request-context';
import type {MastraModelConfig} from '@mastra/core/llm';
import {AiIntegrationBindings, IRunRegistry} from '../../keys';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {MastraToolStore, ToolStatus} from '../../graphs/types';
import type {Tool} from '@mastra/core/tools';
import {UsageAccumulator} from '../../services/usage-accumulator.service';
import {AsyncEventQueue} from './async-event-queue';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import type {IDbConnector} from '../../components/db-query/types';

/**
 * Safe conversion of any thrown value to a non-empty error message.
 * Used by the pump task's chunk + outer catches so the SSE Error
 * event never carries an undefined / empty payload.
 */
function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message ?? fallback;
  return String(err ?? fallback);
}

function textDeltaEvent(payload: unknown): LLMStreamEvent {
  return {
    type: LLMStreamEventType.Message,
    data: {message: (payload as {text: string}).text},
  };
}

function toolCallEvent(payload: unknown): LLMStreamEvent {
  const p = payload as {toolCallId: string; toolName: string; args?: unknown};
  return {
    type: LLMStreamEventType.Tool,
    data: {
      id: p.toolCallId,
      tool: p.toolName,
      data: (p.args ?? {}) as Record<string, unknown>,
    },
  };
}

function toolStatusEvent(payload: unknown): LLMStreamEvent {
  const p = payload as {toolCallId?: string; toolName?: string; args?: unknown};
  return {
    type: LLMStreamEventType.ToolStatus,
    data: {
      id: p.toolCallId ?? 'unknown',
      status: ToolStatus.AwaitingApproval,
      data: {toolName: p.toolName, args: p.args},
    },
  };
}

function tripwireEvent(payload: unknown): LLMStreamEvent {
  const p = payload as {processorId?: string; reason?: string};
  return {
    type: LLMStreamEventType.Error,
    data: {
      message: `Blocked by ${p.processorId ?? 'processor'}: ${p.reason ?? 'tripwire'}`,
    },
  };
}

function chunkErrorEvent(payload: unknown): LLMStreamEvent {
  const err = (payload as {error?: unknown}).error;
  return {
    type: LLMStreamEventType.Error,
    data: {message: toErrorMessage(err, 'error')},
  };
}

const CHUNK_MAPPERS: Record<string, (p: unknown) => LLMStreamEvent> = {
  'text-delta': textDeltaEvent,
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
  payload: unknown;
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
  constructor(
    @inject.context() private lb4Ctx: Context,
    @inject(AiIntegrationBindings.Mastra) private mastra: Mastra,
    @inject(AiIntegrationBindings.MastraChatLLM, {optional: true})
    private chatLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.RunRegistry)
    private runRegistry?: IRunRegistry,
    @inject(AiIntegrationBindings.ResourceId, {optional: true})
    private resourceIdValue?: string,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    private systemContext?: string[],
    @service(UsageAccumulator) private usage?: UsageAccumulator,
    @inject(AiIntegrationBindings.MastraTools, {optional: true})
    private mastraTools?: MastraToolStore,
  ) {}

  async *run(
    query: string,
    files: Express.Multer.File[] | undefined,
    abort: AbortSignal,
    sessionId?: string,
  ): AsyncIterable<LLMStreamEvent> {
    const queue = new AsyncEventQueue<LLMStreamEvent>();

    const agent = this.buildAgent();
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
    let thread;
    let resourceId: string;
    if (sessionId) {
      thread = await memory.getThreadById({threadId: sessionId});
      if (!thread) {
        queue.push({
          type: LLMStreamEventType.Error,
          data: {message: `Thread ${sessionId} not found`},
        });
        queue.close();
        yield* queue;
        return;
      }
      // Resume path: the stored thread.resourceId wins so the second
      // turn shares the same Memory scope as the first.
      resourceId = thread.resourceId ?? this.resourceIdValue ?? randomUUID();
    } else {
      resourceId = this.resourceIdValue ?? randomUUID();
      thread = await memory.createThread({resourceId});
      queue.push({
        type: LLMStreamEventType.Init,
        data: {sessionId: thread.id},
      });
    }

    // File summarisation — v2 SummariseFileNode equivalent. Wired in a
    // follow-up commit once SummariseFileService is extracted. For each file
    // the runner should emit a Status event before invoking the file LLM.
    if (files?.length) {
      for (const file of files) {
        queue.push({
          type: LLMStreamEventType.Status,
          data: `Reading file: ${file.originalname}`,
        });
      }
    }

    // Pull bounded LB4 service refs dynamically from the REQUEST-scoped
    // context. Optional — each is undefined if the consumer hasn't bound
    // the DbQuery component. Workflow steps destructure defensively.
    const dbConnector = await this.lb4Ctx.get<IDbConnector>(
      DbQueryAIExtensionBindings.Connector,
      {optional: true},
    );

    const ctx = new RequestContext<Record<string, unknown>>([
      ['resourceId', resourceId],
      ['eventWriter', (e: LLMStreamEvent) => queue.push(e)],
      ['dbConnector', dbConnector],
      ['chatLlm', this.chatLlm],
      // Expose the LB4 Context to step bodies that need to resolve
      // additional helpers (DbSchemaHelperService, SchemaStore,
      // TableSearchService, etc.) lazily. Workflow steps that need
      // helpers do `requestContext.get<Context>('lb4Ctx').get(key)`.
      ['lb4Ctx', this.lb4Ctx],
    ]);

    // Pump fullStream chunks into the queue. The pre-processing block above
    // and any tool-side eventWriter calls push onto the same queue; total
    // order is preserved by sequential push semantics.
    const streamPromise = agent.stream([{role: 'user', content: query}], {
      maxSteps: 60,
      abortSignal: abort,
      requestContext: ctx,
      memory: {thread: thread.id, resource: resourceId},
    });

    // Pump task is fire-and-forget; completion is signalled by queue.close()
    // inside the inner finally. The inner try/catch maps any thrown error to
    // an SSE Error event before closing, so this promise never rejects.
    this.pumpStream(streamPromise, queue, thread.id).catch(() => {
      /* errors handled inside pumpStream; guard satisfies no-floating-promises. */
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
    streamPromise: Promise<unknown>,
    queue: AsyncEventQueue<LLMStreamEvent>,
    threadId: string,
  ): Promise<void> {
    type ChunkLike = {type: string; payload: unknown};
    type StreamLike = {
      fullStream: AsyncIterable<ChunkLike>;
      usage: Promise<{inputTokens?: number; outputTokens?: number}>;
      runId?: string | Promise<string>;
    };
    try {
      const stream = (await streamPromise) as unknown as StreamLike;
      for await (const chunk of stream.fullStream) {
        await this.handleChunk(chunk, queue, stream, threadId);
      }
      await this.emitUsage(stream, queue);
    } catch (err) {
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

  private async handleChunk(
    chunk: {type: string; payload: unknown},
    queue: AsyncEventQueue<LLMStreamEvent>,
    stream: {runId?: string | Promise<string>},
    threadId: string,
  ): Promise<void> {
    const event = mapChunkToEvent(chunk);
    if (event) {
      queue.push(event);
      return;
    }
    if (chunk.type === 'finish') {
      await this.maybePersistSuspendedRun(chunk.payload, stream, threadId);
    }
  }

  /**
   * When a finish chunk reports finishReason='suspended', persist the
   * runId on the registry so ApprovalController can resume the run on
   * the next request.
   */
  private async maybePersistSuspendedRun(
    payload: unknown,
    stream: {runId?: string | Promise<string>},
    threadId: string,
  ): Promise<void> {
    const finishReason = (payload as {output?: {finishReason?: string}})?.output
      ?.finishReason;
    if (finishReason !== 'suspended') return;
    const runId = (payload as {runId?: string})?.runId ?? (await stream?.runId);
    if (runId && this.runRegistry) {
      await this.runRegistry.set(threadId, runId);
    }
  }

  private async emitUsage(
    stream: {
      usage: Promise<{inputTokens?: number; outputTokens?: number}>;
    },
    queue: AsyncEventQueue<LLMStreamEvent>,
  ): Promise<void> {
    try {
      const u = await stream.usage;
      this.usage?.add('chat-llm', {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
      });
      queue.push({
        type: LLMStreamEventType.TokenCount,
        data: {
          inputTokens: u.inputTokens ?? 0,
          outputTokens: u.outputTokens ?? 0,
        },
      });
    } catch {
      // usage may reject on error / abort paths; skip TokenCount
    }
  }

  /**
   * Build a per-request Agent. Memory is reused from the singleton ChatAgent
   * so storage pools are shared; only the Agent + tool registry shape is
   * per-request.
   */
  private buildAgent(): Agent {
    const singleton = this.mastra.getAgent('chatAgent');
    if (!singleton) {
      throw new Error(
        'ChatAgent not registered in MastraProvider — boot order issue',
      );
    }
    const memory =
      typeof singleton.getMemory === 'function'
        ? (singleton as {getMemory: () => unknown}).getMemory()
        : (singleton as {memory?: unknown}).memory;

    return new Agent({
      id: 'chat-agent',
      name: 'ChatAgent',
      instructions: this.buildInstructions(),
      // Fall back to the singleton's placeholder model when no consumer-bound
      // MastraChatLLM is available (e.g. local tests). At runtime, consumers
      // are expected to bind a concrete LanguageModelV2 instance.
      model: this.chatLlm ?? 'openai/gpt-4o-mini',
      tools: this.buildToolMap(),
      memory: memory as ConstructorParameters<typeof Agent>[0]['memory'],
    });
  }

  private buildToolMap(): Record<string, Tool> {
    if (!this.mastraTools) return {};
    return Object.fromEntries(
      this.mastraTools.list.map(t => [t.key, t.build()]),
    );
  }

  private buildInstructions(): string {
    return [
      'You are a helpful AI assistant. Always use one of the available tools if applicable.',
      ...(this.systemContext ?? []),
    ].join('\n');
  }
}

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

/**
 * REQUEST-scoped bridge between LB4 controllers and the singleton Mastra Agent.
 * Replaces v2's ChatGraph.execute(). The single AsyncEventQueue enforces total
 * order across the pre-processing block, the fullStream pump task, and any
 * tool-side eventWriter calls.
 *
 * P1 scope: chat flow + Memory thread management + SSE pump. File summarisation
 * (v2 SummariseFileNode) and live tool wiring are added later in P1.11.
 *
 * Refs: MIGRATION-STRATEGY.md sections 7.6, 12.3, 13.7.
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

    // SECURITY: never share an 'anonymous' bucket — Mastra Memory `scope:'resource'`
    // groups working memory + semantic recall by resourceId. Consumer-bound
    // ResourceId resolver returns `${tenantId}:${userId}` for multi-tenant safety.
    const resourceId = this.resourceIdValue ?? sessionId ?? randomUUID();

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

    let thread;
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
    } else {
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

    const ctx = new RequestContext<Record<string, unknown>>([
      ['resourceId', resourceId],
      ['eventWriter', (e: LLMStreamEvent) => queue.push(e)],
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
    (async () => {
      try {
        const stream = await streamPromise;
        for await (const chunk of stream.fullStream) {
          switch (chunk.type) {
            case 'text-delta':
              queue.push({
                type: LLMStreamEventType.Message,
                data: {message: chunk.payload.text},
              });
              break;
            case 'tool-call':
              queue.push({
                type: LLMStreamEventType.Tool,
                data: {
                  id: chunk.payload.toolCallId,
                  tool: chunk.payload.toolName,
                  data: (chunk.payload.args ?? {}) as Record<string, unknown>,
                },
              });
              break;
            case 'tool-call-approval':
            case 'tool-call-suspended':
              queue.push({
                type: LLMStreamEventType.ToolStatus,
                data: {
                  id:
                    (chunk.payload as {toolCallId?: string}).toolCallId ??
                    'unknown',
                  status: ToolStatus.AwaitingApproval,
                  data: {
                    toolName: (chunk.payload as {toolName?: string}).toolName,
                    args: (chunk.payload as {args?: unknown}).args,
                  },
                },
              });
              break;
            case 'tripwire':
              queue.push({
                type: LLMStreamEventType.Error,
                data: {
                  message: `Blocked by ${chunk.payload.processorId ?? 'processor'}: ${
                    chunk.payload.reason ?? 'tripwire'
                  }`,
                },
              });
              break;
            case 'error': {
              const err = (chunk.payload as {error?: unknown}).error;
              queue.push({
                type: LLMStreamEventType.Error,
                data: {
                  message:
                    err instanceof Error ? err.message : String(err ?? 'error'),
                },
              });
              break;
            }
            case 'finish':
              // Persist runId on suspend so ApprovalController can resume.
              // The finish chunk payload shape varies across Mastra patch
              // versions; cast defensively.
              if (
                (chunk.payload as {output?: {finishReason?: string}})?.output
                  ?.finishReason === 'suspended'
              ) {
                const runId =
                  (chunk.payload as {runId?: string})?.runId ??
                  (await (stream as {runId?: string | Promise<string>})?.runId);
                if (runId && thread && this.runRegistry) {
                  await this.runRegistry.set(thread.id, runId);
                }
              }
              break;
          }
        }
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
      } catch (err) {
        queue.push({
          type: LLMStreamEventType.Error,
          data: {message: (err as Error).message},
        });
      } finally {
        queue.close();
      }
    })().catch(() => {
      /* errors handled inside the IIFE; this guard satisfies no-floating-promises. */
    });

    yield* queue;
  }

  /**
   * Build a per-request Agent. Memory is reused from the singleton ChatAgent
   * so storage pools are shared; only the Agent + tool registry shape is
   * per-request (Section 3.3 + 7.6).
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

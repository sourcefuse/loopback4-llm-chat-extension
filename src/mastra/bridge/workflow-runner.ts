import {
  BindingScope,
  Getter,
  inject,
  injectable,
  service,
} from '@loopback/core';
import {repository} from '@loopback/repository';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {RequestContext} from '@mastra/core/request-context';
import {ChatStore} from '../../graphs/chat/chat.store';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {AiIntegrationBindings} from '../../keys';
import {ChatRepository} from '../../repositories';
import {AIIntegrationConfig, ToolStore} from '../../types';
import {chatWorkflow} from '../workflows/chat/chat.workflow';
import {AsyncEventQueue} from './async-event-queue';
import {TokenUsageAccumulator} from './token-usage-accumulator';
import type {MastraLanguageModel} from '@mastra/core/agent';

const debug = require('debug')('ai-integration:mastra:workflow-runner');

/**
 * Type guard: checks if an unknown value is an LLMStreamEvent.
 * Used to extract typed events from workflow-step-output stream chunks.
 */
function isLLMStreamEvent(value: unknown): value is LLMStreamEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'data' in value &&
    typeof (value as {type: unknown}).type === 'string'
  );
}

/**
 * WorkflowRunner — the LoopBack 4 ↔ Mastra bridge.
 *
 * Responsibilities:
 *  1. Resolve all REQUEST-scoped LoopBack services (ChatStore, LLMs, etc.)
 *  2. Build a typed RequestContext and inject it into the Mastra ChatWorkflow
 *  3. Stream the workflow via run.stream() and concurrently drain the AsyncEventQueue
 *  4. Yield LLMStreamEvents to the caller (GenerationService forwards to ITransport)
 *
 * Event sources:
 *  - Workflow stream: steps emit Init/Status/Log/TokenCount/Message via writer.write()
 *    → surfaced as workflow-step-output chunks; extracted via isLLMStreamEvent()
 *  - AsyncEventQueue: agent callbacks emit Tool/ToolStatus events
 *    → drained concurrently via _mergeStreams()
 *
 * Scope: REQUEST — one instance per HTTP request, discarded after the request ends.
 */
@injectable({scope: BindingScope.REQUEST})
export class WorkflowRunner {
  constructor(
    @service(ChatStore)
    private readonly chatStore: ChatStore,
    @inject(AiIntegrationBindings.MastraChatLLM)
    private readonly mastraChatLlm: MastraLanguageModel,
    @inject(AiIntegrationBindings.MastraFileLLM, {optional: true})
    private readonly mastraFileLlm: MastraLanguageModel | undefined,
    @inject(AiIntegrationBindings.Tools)
    private readonly toolStore: ToolStore,
    @inject(AiIntegrationBindings.Config, {optional: true})
    private readonly aiConfig: AIIntegrationConfig | undefined,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    private readonly systemContext: string[] | undefined,
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    private readonly getCurrentUser: Getter<IAuthUserWithPermissions>,
    @repository(ChatRepository)
    private readonly chatRepository: ChatRepository,
  ) {}

  /**
   * Execute the ChatWorkflow and yield LLMStreamEvents as they are produced.
   *
   * Callers (GenerationService) iterate this generator and forward each event
   * to ITransport. WorkflowRunner does NOT hold a reference to ITransport.
   */
  async *executeChatWorkflow(
    prompt: string,
    files: Express.Multer.File[],
    abortController: AbortController,
    sessionId?: string,
  ): AsyncGenerator<LLMStreamEvent> {
    const eventQueue = new AsyncEventQueue();
    const tokenAccumulator = new TokenUsageAccumulator();

    const requestContext = new RequestContext();

    requestContext.set('abortSignal', abortController.signal);
    requestContext.set('eventQueue', eventQueue);
    requestContext.set('mastraChatLlm', this.mastraChatLlm);
    requestContext.set(
      'mastraFileLlm',
      this.mastraFileLlm ?? this.mastraChatLlm,
    );
    requestContext.set('chatStore', this.chatStore);
    requestContext.set('toolStore', this.toolStore);
    requestContext.set('aiConfig', this.aiConfig ?? {});
    requestContext.set('systemContext', this.systemContext);
    requestContext.set('tokenUsageAccumulator', tokenAccumulator);

    const run = await chatWorkflow.createRun();

    // run.stream() executes the workflow lazily as we consume the returned iterator.
    // The iterator yields WorkflowStreamEvent — steps emit via writer.write() which
    // surfaces as {type: 'workflow-step-output', payload: {output: <our event>}}.
    const workflowStream = run.stream({
      inputData: {prompt, files, sessionId},
      requestContext,
    });

    // Merge the workflow stream (writer.write events) and AsyncEventQueue (agent callbacks)
    // concurrently. Yield all LLMStreamEvents to GenerationService in arrival order.
    yield* this._mergeStreams(workflowStream, eventQueue, abortController);
  }

  /**
   * Merge the Mastra workflow stream and the AsyncEventQueue into a single
   * LLMStreamEvent generator using Promise.race() for fair interleaving.
   *
   * - Workflow stream yields WorkflowStreamEvent; we extract LLMStreamEvents
   *   from `workflow-step-output` chunks via isLLMStreamEvent().
   * - AsyncEventQueue yields LLMStreamEvents directly (Tool/ToolStatus from agent callbacks).
   *
   * The generator completes when BOTH sources are exhausted.
   */
  private async *_mergeStreams(
    workflowStream: AsyncIterable<unknown>,
    queue: AsyncEventQueue,
    abortController: AbortController,
  ): AsyncGenerator<LLMStreamEvent> {
    const wsIter = workflowStream[Symbol.asyncIterator]();
    const qIter = queue[Symbol.asyncIterator]();

    type SlotResult = {done?: boolean; value: unknown; source: 'ws' | 'queue'};

    // Kick off the first read from both sources before entering the race loop
    let wsPromise: Promise<SlotResult> = wsIter
      .next()
      .then(r => ({done: r.done, value: r.value, source: 'ws' as const}));
    let qPromise: Promise<SlotResult> = qIter
      .next()
      .then(r => ({done: r.done, value: r.value, source: 'queue' as const}));

    let wsDone = false;
    let qDone = false;

    while (!wsDone || !qDone) {
      if (abortController.signal.aborted) {
        debug('WorkflowRunner: abort signal received, stopping merge');
        break;
      }

      // Build the list of active (not yet done) promises
      const active: Promise<SlotResult>[] = [];
      if (!wsDone) active.push(wsPromise);
      if (!qDone) active.push(qPromise);

      if (!active.length) break;

      const result = await Promise.race(active);

      if (result.source === 'ws') {
        if (result.done) {
          wsDone = true;
          debug('WorkflowRunner: workflow stream exhausted');
        } else {
          // Extract LLMStreamEvent from workflow-step-output chunks
          const chunk = result.value as {
            type?: string;
            payload?: {output?: unknown};
          };
          if (chunk?.type === 'workflow-step-output') {
            const output = chunk.payload?.output;
            if (isLLMStreamEvent(output)) {
              if (output.type !== LLMStreamEventType.Log) {
                yield output;
              } else {
                debug(
                  'WorkflowRunner: Log event (not forwarded):',
                  output.data,
                );
              }
            }
          }
          // Schedule the next read from the workflow stream
          wsPromise = wsIter
            .next()
            .then(r => ({done: r.done, value: r.value, source: 'ws' as const}));
        }
      } else {
        // source === 'queue'
        if (result.done) {
          qDone = true;
          debug('WorkflowRunner: AsyncEventQueue exhausted');
        } else {
          const event = result.value as LLMStreamEvent;
          if (event.type !== LLMStreamEventType.Log) {
            yield event;
          } else {
            debug(
              'WorkflowRunner: Log event from queue (not forwarded):',
              event.data,
            );
          }
          // Schedule the next read from the queue
          qPromise = qIter.next().then(r => ({
            done: r.done,
            value: r.value,
            source: 'queue' as const,
          }));
        }
      }
    }

    debug('WorkflowRunner: merge complete');
  }
}

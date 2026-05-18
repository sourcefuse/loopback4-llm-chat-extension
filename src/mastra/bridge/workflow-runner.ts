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
import {BaseRetriever} from '@langchain/core/retrievers';
import {ChatStore} from '../../graphs/chat/chat.store';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import {AiIntegrationBindings} from '../../keys';
import {ChatRepository} from '../../repositories';
import {AIIntegrationConfig, MastraToolStore} from '../../types';
import {chatWorkflow} from '../workflows/chat/chat.workflow';
import {dbQueryWorkflow} from '../workflows/db-query/db-query.workflow';
import {AsyncEventQueue} from './async-event-queue';
import {TokenUsageAccumulator} from './token-usage-accumulator';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import type {
  DatabaseSchema,
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
  QueryCacheMetadata,
  QueryTemplateMetadata,
} from '../../components/db-query/types';
import {DbSchemaHelperService} from '../../components/db-query/services/db-schema-helper.service';
import {PermissionHelper} from '../../components/db-query/services/permission-helper.service';
import {TableSearchService} from '../../components/db-query/services/search/table-search.service';
import {TemplateHelper} from '../../components/db-query/services/template-helper.service';
import {DataSetHelper} from '../../components/db-query/services/dataset-helper.service';
import {SchemaStore} from '../../components/db-query/services/schema.store';
import type {
  CacheDocument,
  TemplateDocument,
} from '../workflows/db-query/db-query-request-context';

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
    @inject(AiIntegrationBindings.MastraTools)
    private readonly mastraTools: MastraToolStore,
    @inject(AiIntegrationBindings.Config, {optional: true})
    private readonly aiConfig: AIIntegrationConfig | undefined,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    private readonly systemContext: string[] | undefined,
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    private readonly getCurrentUser: Getter<IAuthUserWithPermissions>,
    @repository(ChatRepository)
    private readonly chatRepository: ChatRepository,
    // ── DBQuery bindings (optional — only present when DB Query component is loaded)
    @inject(AiIntegrationBindings.MastraCheapLLM, {optional: true})
    private readonly mastraCheapLlm: MastraLanguageModel | undefined,
    @inject(AiIntegrationBindings.MastraSmartLLM, {optional: true})
    private readonly mastraSmartLlm: MastraLanguageModel | undefined,
    @inject(AiIntegrationBindings.MastraSmartNonThinkingLLM, {optional: true})
    private readonly mastraSmartNonThinkingLlm: MastraLanguageModel | undefined,
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    private readonly dbQueryConfig: DbQueryConfig | undefined,
    @inject(DbQueryAIExtensionBindings.DatasetStore, {optional: true})
    private readonly datasetStore: IDataSetStore | undefined,
    @inject(DbQueryAIExtensionBindings.Connector, {optional: true})
    private readonly connector: IDbConnector | undefined,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly dbGlobalContext: string[] | undefined,
    @service(SchemaStore, {optional: true})
    private readonly schemaStore: SchemaStore | undefined,
    @service(DbSchemaHelperService, {optional: true})
    private readonly schemaHelper: DbSchemaHelperService | undefined,
    @service(PermissionHelper, {optional: true})
    private readonly permissionHelper: PermissionHelper | undefined,
    @service(TableSearchService, {optional: true})
    private readonly tableSearchService: TableSearchService | undefined,
    @service(TemplateHelper, {optional: true})
    private readonly templateHelper: TemplateHelper | undefined,
    @service(DataSetHelper, {optional: true})
    private readonly datasetHelper: DataSetHelper | undefined,
    @inject(DbQueryAIExtensionBindings.QueryCache, {optional: true})
    private readonly queryCacheRetriever:
      | BaseRetriever<QueryCacheMetadata>
      | undefined,
    @inject(DbQueryAIExtensionBindings.TemplateCache, {optional: true})
    private readonly templateCacheRetriever:
      | BaseRetriever<QueryTemplateMetadata>
      | undefined,
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
    const currentUser = await this.resolveOptionalCurrentUser();

    const requestContext = new RequestContext();

    requestContext.set('abortSignal', abortController.signal);
    requestContext.set('eventQueue', eventQueue);
    requestContext.set('mastraChatLlm', this.mastraChatLlm);
    requestContext.set(
      'mastraFileLlm',
      this.mastraFileLlm ?? this.mastraChatLlm,
    );
    requestContext.set('chatStore', this.chatStore);
    requestContext.set('mastraTools', this.mastraTools);
    requestContext.set('aiConfig', this.aiConfig ?? {});
    requestContext.set('systemContext', this.systemContext);
    requestContext.set('tokenUsageAccumulator', tokenAccumulator);
    requestContext.set('currentUser', currentUser);

    const chatDbQuerySchema = this.resolveDbQueryChatSchema();
    if (chatDbQuerySchema) {
      this.bindDbQueryContext(requestContext, {
        schema: chatDbQuerySchema,
        abortSignal: abortController.signal,
        currentUser,
        directCall: false,
      });
    }

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
   * Execute the DBQueryWorkflow and yield LLMStreamEvents as they are produced.
   *
   * Callers invoke this for database query generation. The workflow is entirely
   * deterministic (no Agent involved — only LLM calls via step handlers).
   */
  async *executeDbQueryWorkflow(
    prompt: string,
    schema: DatabaseSchema,
    abortController: AbortController,
    options?: {datasetId?: string; directCall?: boolean},
  ): AsyncGenerator<LLMStreamEvent> {
    if (
      !this.mastraCheapLlm ||
      !this.mastraSmartLlm ||
      !this.dbQueryConfig ||
      !this.datasetStore ||
      !this.connector ||
      !this.schemaStore ||
      !this.schemaHelper ||
      !this.tableSearchService ||
      !this.templateHelper ||
      !this.datasetHelper ||
      !this.queryCacheRetriever ||
      !this.templateCacheRetriever
    ) {
      throw new Error(
        'DBQuery workflow requires DB Query component bindings. ' +
          'Ensure MastraCheapLLM, MastraSmartLLM, cache retrievers, and all DB Query services are bound.',
      );
    }

    const currentUser = await this.getCurrentUser();

    const requestContext = new RequestContext();
    this.bindDbQueryContext(requestContext, {
      schema,
      abortSignal: abortController.signal,
      currentUser,
      directCall: options?.directCall ?? false,
    });

    const run = await dbQueryWorkflow.createRun();

    const workflowStream = run.stream({
      inputData: {
        prompt,
        schema,
        datasetId: options?.datasetId,
        directCall: options?.directCall,
      },
      requestContext,
    });

    // DBQuery doesn't use AsyncEventQueue (no Agent/tool callbacks)
    // but we still use _mergeStreams for consistency with the abort logic
    const emptyQueue = new AsyncEventQueue();
    emptyQueue.close(); // immediately close since no events will come from it

    yield* this._mergeStreams(workflowStream, emptyQueue, abortController);
  }

  private async resolveOptionalCurrentUser(): Promise<
    IAuthUserWithPermissions | undefined
  > {
    try {
      return await this.getCurrentUser();
    } catch {
      return undefined;
    }
  }

  private resolveDbQueryChatSchema(): DatabaseSchema | undefined {
    if (!this.mastraCheapLlm) {
      return undefined;
    }
    if (!this.schemaStore) {
      throw new Error(
        'SchemaStore is required for DBQuery tool execution in ChatWorkflow.',
      );
    }
    return this.schemaStore.get();
  }

  private bindDbQueryContext(
    requestContext: RequestContext,
    params: {
      schema: DatabaseSchema;
      abortSignal: AbortSignal;
      currentUser: IAuthUserWithPermissions | undefined;
      directCall: boolean;
    },
  ): void {
    if (
      !this.mastraCheapLlm ||
      !this.mastraSmartLlm ||
      !this.dbQueryConfig ||
      !this.datasetStore ||
      !this.connector ||
      !this.schemaStore ||
      !this.schemaHelper ||
      !this.tableSearchService ||
      !this.templateHelper ||
      !this.datasetHelper ||
      !this.queryCacheRetriever ||
      !this.templateCacheRetriever
    ) {
      throw new Error(
        'DBQuery context binding requires all DBQuery dependencies and retrievers to be configured.',
      );
    }

    const queryCacheRetriever = this.queryCacheRetriever;
    const templateCacheRetriever = this.templateCacheRetriever;

    requestContext.set('cheapLlm', this.mastraCheapLlm);
    requestContext.set('smartLlm', this.mastraSmartLlm);
    requestContext.set('smartNonThinkingLlm', this.mastraSmartNonThinkingLlm);
    requestContext.set('dbQueryConfig', this.dbQueryConfig);
    requestContext.set('datasetStore', this.datasetStore);
    requestContext.set('connector', this.connector);
    requestContext.set('schemaStore', this.schemaStore);
    requestContext.set('schemaHelper', this.schemaHelper);
    requestContext.set('permissionHelper', this.permissionHelper);
    requestContext.set('tableSearchService', this.tableSearchService);
    requestContext.set('templateHelper', this.templateHelper);
    requestContext.set('datasetHelper', this.datasetHelper);
    requestContext.set('globalContext', this.dbGlobalContext ?? []);
    requestContext.set('abortSignal', params.abortSignal);
    requestContext.set('currentUser', params.currentUser);
    requestContext.set('fullSchema', params.schema);
    requestContext.set('directCall', params.directCall);
    requestContext.set('queryCache', {
      invoke: async (query: string): Promise<CacheDocument[]> => {
        const docs = await queryCacheRetriever.invoke(query);
        return docs
          .map(doc => ({
            pageContent: doc.pageContent,
            metadata: {
              datasetId: doc.metadata.datasetId,
              query: doc.metadata.query,
              description: doc.metadata.description,
              votes: doc.metadata.votes,
            },
          }))
          .filter(doc => !!doc.metadata.datasetId && !!doc.metadata.query);
      },
    });
    requestContext.set('templateCache', {
      invoke: async (query: string): Promise<TemplateDocument[]> => {
        const docs = await templateCacheRetriever.invoke(query);
        return docs
          .map(doc => ({
            pageContent: doc.pageContent,
            metadata: {
              templateId: doc.metadata.templateId,
              template: doc.metadata.template,
              type: doc.metadata.type,
              description: doc.metadata.description,
              votes: doc.metadata.votes,
              placeholders: doc.metadata.placeholders,
              tables: doc.metadata.tables,
              schemaHash: doc.metadata.schemaHash,
            },
          }))
          .filter(doc => !!doc.metadata.templateId && !!doc.metadata.template);
      },
    });
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

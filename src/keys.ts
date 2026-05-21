import {VectorStore as VectorStoreType} from '@langchain/core/vectorstores';
import {BindingKey} from '@loopback/context';
import type {MastraLanguageModel} from '@mastra/core/agent';
import type {Mastra} from '@mastra/core/mastra';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraEmbeddingModel, MastraVector} from '@mastra/core/vector';
import type {WorkflowRunner} from './mastra/bridge/workflow-runner';
import {ITransport} from './transports/types';
import {
  AIIntegrationConfig,
  EmbeddingProvider,
  ICache,
  LLMProvider,
  MastraToolStore,
  ToolStore,
} from './types';
import {ILimitStrategy} from './services/limit-strategies/types';

export interface IRunRegistry {
  set(sessionId: string, runId: string): Promise<void>;
  get(sessionId: string): Promise<string | undefined>;
  delete(sessionId: string): Promise<void>;
}

export namespace AiIntegrationBindings {
  export const Config = BindingKey.create<AIIntegrationConfig>(
    'services.ai-reporting.config',
  );
  export const SmartLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.smartLLMProvider',
  );
  export const CheapLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.cheapLLMProvider',
  );
  export const FileLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.fileLLMProvider',
  );
  export const ChatLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.chatLLMProvider',
  );
  export const SmartNonThinkingLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.smartNonThinkingLLMProvider',
  );
  export const EmbeddingModel = BindingKey.create<EmbeddingProvider>(
    'services.ai-reporting.embeddingModel',
  );
  export const Tools = BindingKey.create<ToolStore>(
    'services.ai-reporting.tool-store',
  );
  export const MastraTools = BindingKey.create<MastraToolStore>(
    'services.ai-reporting.mastra-tool-store',
  );
  export const Transport = BindingKey.create<ITransport>(
    'services.ai-reporting.transport',
  );
  export const VectorStore = BindingKey.create<VectorStoreType>(
    'services.ai-reporting.vector-store',
  );
  export const Cache = BindingKey.create<ICache>('services.ai-reporting.cache');
  export const LimitStrategy = BindingKey.create<ILimitStrategy>(
    'services.ai-reporting.limit-strategy',
  );
  export const ObfHandler = BindingKey.create<unknown>(
    'services.ai-reporting.obf-handler',
  );
  export const SystemContext = BindingKey.create<string[]>(
    `services.ai-reporting.system-context`,
  );

  // ── Mastra foundation bindings (Phase 1 migration) ──────────────────────
  export const Mastra = BindingKey.create<Mastra>(
    'services.ai-reporting.mastra',
  );

  export const MastraStorage = BindingKey.create<MastraCompositeStore>(
    'services.ai-reporting.mastraStorage',
  );

  export const MastraVectorStore = BindingKey.create<MastraVector>(
    'services.ai-reporting.mastraVectorStore',
  );

  export const MastraEmbedder = BindingKey.create<MastraEmbeddingModel<string>>(
    'services.ai-reporting.mastraEmbedder',
  );

  export const RunRegistry = BindingKey.create<IRunRegistry>(
    'services.ai-reporting.runRegistry',
  );

  export const WorkflowRunner = BindingKey.create<WorkflowRunner>(
    'services.ai-reporting.workflowRunner',
  );

  export const ResourceId = BindingKey.create<string>(
    'services.ai-reporting.resourceId',
  );

  // ── Mastra LLM bindings (Phase 1 migration) ──────────────────────────────
  /**
   * Mastra-compatible chat LLM.
   * Bind a `MastraLanguageModel` (e.g. from @mastra/openai, @mastra/anthropic, etc.)
   * to this key in your application's `application.ts`.
   *
   * Example:
   *   app.bind(AiIntegrationBindings.MastraChatLLM).to(openai('gpt-4o'));
   */
  export const MastraChatLLM = BindingKey.create<MastraLanguageModel>(
    'services.ai-reporting.mastraChatLLMProvider',
  );

  /**
   * Mastra-compatible file/document processing LLM (optional).
   * Used by FileProcessingStep to summarise uploaded files.
   * Falls back to MastraChatLLM if not bound.
   */
  export const MastraFileLLM = BindingKey.create<MastraLanguageModel>(
    'services.ai-reporting.mastraFileLLMProvider',
  );

  // ── Mastra DBQuery LLM bindings (Phase 2 migration) ──────────────────────

  /**
   * Mastra-compatible cheap/fast LLM for DBQuery workflow.
   * Used for table selection, column selection, classification, etc.
   */
  export const MastraCheapLLM = BindingKey.create<MastraLanguageModel>(
    'services.ai-reporting.mastraCheapLLMProvider',
  );

  /**
   * Mastra-compatible smart/powerful LLM for DBQuery workflow.
   * Used for SQL generation and complex validation.
   */
  export const MastraSmartLLM = BindingKey.create<MastraLanguageModel>(
    'services.ai-reporting.mastraSmartLLMProvider',
  );

  /**
   * Mastra-compatible smart non-thinking LLM (optional).
   * Used for checklist verification. Falls back to MastraSmartLLM.
   */
  export const MastraSmartNonThinkingLLM =
    BindingKey.create<MastraLanguageModel>(
      'services.ai-reporting.mastraSmartNonThinkingLLMProvider',
    );
}
export const WriterDB = 'writerdb';
export const ReaderDB = 'readerdb';

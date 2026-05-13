import {VectorStore as VectorStoreType} from '@langchain/core/vectorstores';
import {BaseCheckpointSaver} from '@langchain/langgraph';
import {BindingKey} from '@loopback/context';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {ITransport} from './transports/types';
import {
  AIIntegrationConfig,
  EmbeddingProvider,
  ICache,
  LLMProvider,
  ToolStore,
} from './types';
import {ILimitStrategy} from './services/limit-strategies/types';

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
  export const Checkpointer = BindingKey.create<BaseCheckpointSaver>(
    'services.ai-reporting.checkpointer',
  );
  export const Tools = BindingKey.create<ToolStore>(
    'services.ai-reporting.tool-store',
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
  export const ObfHandler = BindingKey.create<Function>(
    'services.ai-reporting.obf-handler',
  );
  export const SystemContext = BindingKey.create<string[]>(
    `services.ai-reporting.system-context`,
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
}
export const WriterDB = 'writerdb';
export const ReaderDB = 'readerdb';

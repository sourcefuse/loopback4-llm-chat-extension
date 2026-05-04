import {BindingKey} from '@loopback/context';
import {
  IMastraBridge,
  MastraRuntimeFactory as MastraRuntimeFactoryType,
} from './services/mastra-bridge.service';
import {ITransport} from './transports/types';
import {
  AIIntegrationConfig,
  AiSdkEmbeddingModel as AiSdkEmbeddingModelType,
  EmbeddingProvider,
  ICache,
  IVectorStore,
  IWorkflowPersistence,
  LLMProvider,
  ToolStore,
} from './types';
import {ILimitStrategy} from './services/limit-strategies/types';

export namespace AiIntegrationBindings {
  export const Config = BindingKey.create<AIIntegrationConfig>(
    'services.ai-reporting.config',
  );
  /**
   * @deprecated Use `AiSdkSmartLLM` for the Mastra/AI SDK execution path.
   */
  export const SmartLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.smartLLMProvider',
  );
  /**
   * @deprecated Use `AiSdkCheapLLM` for the Mastra/AI SDK execution path.
   */
  export const CheapLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.cheapLLMProvider',
  );
  /**
   * @deprecated Use `AiSdkFileLLM` for the Mastra/AI SDK execution path.
   */
  export const FileLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.fileLLMProvider',
  );
  /**
   * @deprecated Use `AiSdkFileLLM` for the Mastra/AI SDK execution path.
   */
  export const ChatLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.chatLLMProvider',
  );
  /**
   * @deprecated Use `AiSdkSmartNonThinkingLLM` for the Mastra/AI SDK execution path.
   */
  export const SmartNonThinkingLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.smartNonThinkingLLMProvider',
  );
  /**
   * AI SDK (`LanguageModel`) bindings — used by Mastra path nodes (Phase 3+).
   * Bind these to AI SDK provider instances (e.g. from `lb4-llm-chat-component/openai`
   * using `OpenAISdk`, etc.).  The legacy `SmartLLM` / `CheapLLM` bindings remain
   * for the LangGraph path and are unaffected.
   */
  export const AiSdkSmartLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.aiSdkSmartLLMProvider',
  );
  export const AiSdkCheapLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.aiSdkCheapLLMProvider',
  );
  export const AiSdkFileLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.aiSdkFileLLMProvider',
  );
  export const AiSdkSmartNonThinkingLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.aiSdkSmartNonThinkingLLMProvider',
  );
  /**
   * AI SDK (`LanguageModel`) binding for the chat execution path.
   *
   * Bind a `LanguageModel` instance here.  Used by `MastraChatAgent` to run
   * the conversational LLM loop directly via `streamText()`.
   */
  export const AiSdkChatLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.aiSdkChatLLMProvider',
  );
  export const EmbeddingModel = BindingKey.create<EmbeddingProvider>(
    'services.ai-reporting.embeddingModel',
  );
  /**
   * AI SDK embedding model binding for the Mastra execution path.
   *
   * Bind an `EmbeddingModel<string>` (e.g. from `@ai-sdk/openai`) here.
   * Used by `PgVectorSdkStore` to compute document and query embeddings
   * without any LangChain dependency.
   */
  export const AiSdkEmbeddingModel = BindingKey.create<AiSdkEmbeddingModelType>(
    'services.ai-reporting.aiSdkEmbeddingModel',
  );
  export const WorkflowPersistence = BindingKey.create<IWorkflowPersistence>(
    'services.ai-reporting.workflow-persistence',
  );
  /**
   * @deprecated Use `WorkflowPersistence`.
   */
  export const Checkpointer = WorkflowPersistence;
  export const Tools = BindingKey.create<ToolStore>(
    'services.ai-reporting.tool-store',
  );
  export const Transport = BindingKey.create<ITransport>(
    'services.ai-reporting.transport',
  );
  /**
   * @deprecated Use `AiSdkVectorStore` for the Mastra/AI SDK execution path.
   */
  export const VectorStore = BindingKey.create<IVectorStore>(
    'services.ai-reporting.vector-store',
  );
  /**
   * Mastra-path vector store binding.
   *
   * Bind a `PgVectorSdkStore` (or any `IVectorStore` implementation) here for use
   * by `DatasetSearchService` and `TemplateSearchService` in the Mastra execution path.
   * The LangGraph path continues to use `VectorStore` above.
   */
  export const AiSdkVectorStore = BindingKey.create<IVectorStore>(
    'services.ai-reporting.aiSdkVectorStore',
  );
  export const Cache = BindingKey.create<ICache>('services.ai-reporting.cache');
  export const LimitStrategy = BindingKey.create<ILimitStrategy>(
    'services.ai-reporting.limit-strategy',
  );
  export const ObfHandler = BindingKey.create<Function>(
    'services.ai-reporting.obf-handler',
  );
  /**
   * Mastra-path Langfuse client binding.
   *
   * Registered automatically by `LangfuseMastraComponent`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const LangfuseMastraClient = BindingKey.create<any>(
    'services.ai-reporting.langfuse-mastra-client',
  );
  export const MastraBridge = BindingKey.create<IMastraBridge>(
    'services.ai-reporting.mastra-bridge',
  );
  export const MastraRuntimeFactory =
    BindingKey.create<MastraRuntimeFactoryType>(
      'services.ai-reporting.mastra-runtime-factory',
    );
  export const SystemContext = BindingKey.create<string[]>(
    `services.ai-reporting.system-context`,
  );
}
export const WriterDB = 'writerdb';
export const ReaderDB = 'readerdb';

import {VectorStore as VectorStoreType} from '@langchain/core/vectorstores';
import {BaseCheckpointSaver} from '@langchain/langgraph';
import type {Mastra} from '@mastra/core';
import type {MastraModelConfig} from '@mastra/core/llm';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraVector, MastraEmbeddingModel} from '@mastra/core/vector';
import {BindingKey} from '@loopback/context';
import {ITransport} from './transports/types';
import {
  AIIntegrationConfig,
  EmbeddingProvider,
  ICache,
  LLMProvider,
  ToolStore,
} from './types';
import {ILimitStrategy} from './services/limit-strategies/types';

// Swappable run registry for HITL approval flow (Section 8.2.1). Default impl is
// in-process; consumers may bind a Redis-backed variant for multi-pod deployments.
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

  // Mastra v3 bindings — added in P1.
  export const Mastra = BindingKey.create<Mastra>(
    'services.ai-reporting.mastra',
  );
  export const MastraChatLLM = BindingKey.create<MastraModelConfig>(
    'services.ai-reporting.mastraChatLlm',
  );
  export const MastraFileLLM = BindingKey.create<MastraModelConfig>(
    'services.ai-reporting.mastraFileLlm',
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
  // ResourceId — tenant-scoped identity string resolved per-request via
  // toDynamicValue (Section 13.7). Format: `${tenantId}:${userId}`.
  export const ResourceId = BindingKey.create<string>(
    'services.ai-reporting.resourceId',
  );
}
export const WriterDB = 'writerdb';
export const ReaderDB = 'readerdb';

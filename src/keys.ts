import type {MastraVector} from '@mastra/core/vector';
import {BindingKey} from '@loopback/context';
import {ITransport} from './transports/types';
import {
  AIIntegrationConfig,
  EmbeddingProvider,
  ICache,
  LLMProvider,
} from './types';
import {ILimitStrategy} from './services/limit-strategies/types';

// Swappable run registry for HITL approval flow. Default impl is
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
  // Strict-structured-output tier (line visualizer's generateObject). A
  // reasoning model with thinking disabled — "thinking" chunks break some
  // providers' strict structured output. Optional; workflow sites fall
  // back to ChatLLM when unbound.
  export const SmartNonThinkingLLM = BindingKey.create<LLMProvider>(
    'services.ai-reporting.smartNonThinkingLLMProvider',
  );
  export const EmbeddingModel = BindingKey.create<EmbeddingProvider>(
    'services.ai-reporting.embeddingModel',
  );
  export const Transport = BindingKey.create<ITransport>(
    'services.ai-reporting.transport',
  );
  export const VectorStore = BindingKey.create<MastraVector>(
    'services.ai-reporting.vector-store',
  );
  export const Cache = BindingKey.create<ICache>('services.ai-reporting.cache');
  export const LimitStrategy = BindingKey.create<ILimitStrategy>(
    'services.ai-reporting.limit-strategy',
  );
  export const SystemContext = BindingKey.create<string[]>(
    `services.ai-reporting.system-context`,
  );
  // NOTE: Mastra runtime infra bindings (Mastra, Storage, Tools,
  // Observability, RunRegistry, ResourceId) live in MastraInternalBindings
  // (src/mastra/internal-bindings.ts) — they are not part of the
  // host-facing API surface. Host model bindings stay here as the canonical
  // ChatLLM / FileLLM / CheapLLM / SmartLLM / SmartNonThinkingLLM tiers.
}
export const WriterDB = 'writerdb';
export const ReaderDB = 'readerdb';

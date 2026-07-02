import type {Mastra as MastraType} from '@mastra/core';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraVector} from '@mastra/core/vector';
import type {Observability} from '@mastra/observability';
import type {LanguageModel} from 'ai';
import {BindingKey} from '@loopback/context';
import type {ToolStore} from './graphs/types';
import {ITransport} from './transports/types';
import {
  AIIntegrationConfig,
  EmbeddingProvider,
  FileMessageBuilder as FileMessageBuilderType,
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
  // Optional host-facing observability/tracing handler. Mastra equivalent of
  // v2's `ObfHandler` (a langfuse CallbackHandler injected into every LLM run):
  // bind a Mastra `Observability` here and MastraProvider folds it into the
  // Mastra instance so agent / workflow / tool spans are exported. Prefer
  // binding a dedicated Observability provider; this binding exists so the v2
  // host-facing API (AiIntegrationBindings.ObfHandler) keeps working.
  export const ObfHandler = BindingKey.create<Observability>(
    'services.ai-reporting.obf-handler',
  );
  // Optional per-provider file → LLM message-part builder (v2
  // `LLMProvider.getFile` / `FileMessageBuilder`). When bound, WorkflowRunner's
  // file-summarisation path uses it to shape the file content block for the
  // bound model's API (e.g. AWS Bedrock `document` blocks) instead of the
  // generic `{type:'file'}` default.
  export const FileMessageBuilder = BindingKey.create<FileMessageBuilderType>(
    'services.ai-reporting.file-message-builder',
  );

  // ── Runtime infra bindings ────────────────────────────────────────────
  // Now that the extension is Mastra-only there is a single bindings
  // namespace: these live alongside the host model tiers above instead of a
  // separate internal namespace. A host may override any of them (e.g. bind
  // Storage to the Postgres provider, or RunRegistry to a Redis-backed one).
  export const Mastra = BindingKey.create<MastraType>(
    'services.ai-reporting.mastra',
  );
  export const Storage = BindingKey.create<MastraCompositeStore>(
    'services.ai-reporting.mastraStorage',
  );
  export const Tools = BindingKey.create<ToolStore>(
    'services.ai-reporting.mastraTools',
  );
  export const Observability = BindingKey.create<Observability>(
    'services.ai-reporting.mastraObservability',
  );
  export const RunRegistry = BindingKey.create<IRunRegistry>(
    'services.ai-reporting.runRegistry',
  );
  export const ResourceId = BindingKey.create<string>(
    'services.ai-reporting.resourceId',
  );

  // Per-request RESOLVED AI-SDK model tiers. WorkflowRunner binds these into
  // the request context each run (after async `resolveModelConfig`), so step
  // classes can `@inject` a ready-to-call model instead of reading the config
  // from RequestContext. Optional — unbound tiers fall back to ChatModel in the
  // step (mirroring the old getCheapLlm/getSmartLlm rc-accessor fallbacks).
  export const ChatModel = BindingKey.create<LanguageModel>(
    'services.ai-reporting.runtime.chatModel',
  );
  export const CheapModel = BindingKey.create<LanguageModel>(
    'services.ai-reporting.runtime.cheapModel',
  );
  export const SmartModel = BindingKey.create<LanguageModel>(
    'services.ai-reporting.runtime.smartModel',
  );
  export const SmartNonThinkingModel = BindingKey.create<LanguageModel>(
    'services.ai-reporting.runtime.smartNonThinkingModel',
  );
}
export const WriterDB = 'writerdb';
export const ReaderDB = 'readerdb';

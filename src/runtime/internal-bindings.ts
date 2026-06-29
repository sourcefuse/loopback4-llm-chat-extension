import {BindingKey} from '@loopback/context';
import type {Mastra} from '@mastra/core';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {Observability} from '@mastra/observability';
import type {LanguageModel} from 'ai';
import type {ToolStore} from '../graphs/types';
import type {IRunRegistry} from '../keys';

/**
 * Internal Mastra-only bindings. These are intentionally not part of
 * AiIntegrationBindings so host apps can keep using legacy keys.
 */
export namespace InternalBindings {
  export const Mastra = BindingKey.create<Mastra>(
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

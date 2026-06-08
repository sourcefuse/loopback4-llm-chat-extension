import {BindingKey} from '@loopback/context';
import type {Mastra} from '@mastra/core';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {Observability} from '@mastra/observability';
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
}

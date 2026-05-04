import {Component, ProviderMap} from '@loopback/core';
import {AiIntegrationBindings} from '../../../keys';
import {LangfuseCoreProvider} from './langfuse-core.provider';

/**
 * Mastra-path Langfuse observability component.
 *
 * Registers a `LangfuseAPIClient` (from `@langfuse/core`) under
 * `AiIntegrationBindings.LangfuseMastraClient` for use in the Mastra execution path.
 *
 * This is the Mastra-path equivalent of `LangfuseComponent` which registers a
 * LangChain `CallbackHandler` (from `@langfuse/langchain`) under
 * `AiIntegrationBindings.ObfHandler`.  Both components can coexist in the same
 * application so that LangGraph and Mastra paths each get their own Langfuse client.
 *
 * **Usage** (in your LoopBack application class):
 * ```ts
 * this.component(LangfuseMastraComponent);
 * ```
 *
 * **Prerequisites**:
 * - Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and optionally `LANGFUSE_HOST`.
 *
 * **Injecting the client in a Mastra step**:
 * ```ts
 * import {inject} from '@loopback/core';
 * import {LangfuseAPIClient} from '@langfuse/core';
 * import {AiIntegrationBindings} from '../keys';
 *
 * // Inside a service constructor:
 * @inject(AiIntegrationBindings.LangfuseMastraClient, {optional: true})
 * private readonly langfuse?: LangfuseAPIClient,
 * ```
 */
export class LangfuseMastraComponent implements Component {
  providers?: ProviderMap;

  constructor() {
    this.providers = {
      [AiIntegrationBindings.LangfuseMastraClient.key]: LangfuseCoreProvider,
    };
  }
}

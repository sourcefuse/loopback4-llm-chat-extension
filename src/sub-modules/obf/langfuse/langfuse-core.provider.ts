import {LangfuseAPIClient} from '@langfuse/core';
import {Provider, ValueOrPromise} from '@loopback/core';

/**
 * Mastra-path Langfuse provider.
 *
 * Returns a `LangfuseAPIClient` from `@langfuse/core` — zero LangChain dependency.
 * This is the Mastra-path equivalent of the LangGraph `LangfuseObfProvider` which
 * returns a `CallbackHandler` from `@langfuse/langchain`.
 *
 * The client exposes the full Langfuse REST API (traces, generations, spans,
 * scores, datasets, etc.) and can be used inside Mastra step functions for
 * structured observability via `client.ingestion.ingest({batch: [...]})`.
 *
 * Reads configuration from the standard Langfuse environment variables:
 * - `LANGFUSE_PUBLIC_KEY`  — project public key (required)
 * - `LANGFUSE_SECRET_KEY`  — project secret key (required)
 * - `LANGFUSE_HOST`        — API base URL (optional, defaults to `https://cloud.langfuse.com`)
 *
 * **Binding**: registered automatically by `LangfuseMastraComponent` under
 * `AiIntegrationBindings.LangfuseMastraClient`.
 */
export class LangfuseCoreProvider implements Provider<LangfuseAPIClient> {
  value(): ValueOrPromise<LangfuseAPIClient> {
    if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
      throw new Error(
        'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY environment variables must be set ' +
          'to use LangfuseMastraComponent.',
      );
    }

    return new LangfuseAPIClient({
      environment: process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com',
      username: process.env.LANGFUSE_PUBLIC_KEY,
      password: process.env.LANGFUSE_SECRET_KEY,
    });
  }
}

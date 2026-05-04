import {LangfuseAPIClient} from '@langfuse/core';
import {Provider, ValueOrPromise} from '@loopback/core';

/**
 * Langfuse observability provider (LangChain-free).
 *
 * Previously returned a `CallbackHandler` from `@langfuse/langchain`.
 * Now returns a `LangfuseAPIClient` from `@langfuse/core` — same trigger
 * point, same binding, zero LangChain dependency.
 *
 * Reads configuration from the standard Langfuse environment variables:
 * - `LANGFUSE_PUBLIC_KEY`  — project public key
 * - `LANGFUSE_SECRET_KEY`  — project secret key
 * - `LANGFUSE_HOST`        — API base URL (optional)
 */
export class LangfuseObfProvider implements Provider<LangfuseAPIClient> {
  value(): ValueOrPromise<LangfuseAPIClient> {
    return new LangfuseAPIClient({
      environment: process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com',
      username: process.env.LANGFUSE_PUBLIC_KEY,
      password: process.env.LANGFUSE_SECRET_KEY,
    });
  }
}

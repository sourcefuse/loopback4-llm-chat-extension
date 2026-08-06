import {Provider, ValueOrPromise} from '@loopback/core';

import * as langfuseTracing from '@langfuse/tracing';
import {LLMCallbacks} from '../../../graphs';

/**
 * Observability handler bound to `AiIntegrationBindings.ObfHandler`.
 *
 * Replaces the LangChain `@langfuse/langchain` `CallbackHandler`. It emits
 * Langfuse-compatible OpenTelemetry generation spans (one per LLM call) via
 * `@langfuse/tracing`; the consuming application registers the Langfuse span
 * processor/exporter (see `@langfuse/otel`) to ship them — the standard OTEL
 * wiring. All tracing is best-effort and never interferes with generation.
 */
export class LangfuseObfProvider implements Provider<LLMCallbacks> {
  value(): ValueOrPromise<LLMCallbacks> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const observations = new Map<string, any>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tracing = langfuseTracing as any;
    return {
      handleLLMStart: (runId, modelName) => {
        try {
          if (typeof tracing.startObservation !== 'function') {
            return;
          }
          observations.set(
            runId,
            tracing.startObservation(
              'llm-call',
              {model: modelName},
              {asType: 'generation'},
            ),
          );
        } catch {
          // best-effort tracing; ignore observability failures
        }
      },
      handleLLMEnd: (runId, result) => {
        try {
          const observation = observations.get(runId);
          observations.delete(runId);
          const usage = result.generations?.[0]?.[0]?.message?.usage_metadata;
          observation?.update?.({
            usageDetails: {
              input: usage?.input_tokens,
              output: usage?.output_tokens,
            },
          });
          observation?.end?.();
        } catch {
          // best-effort tracing; ignore observability failures
        }
      },
    };
  }
}

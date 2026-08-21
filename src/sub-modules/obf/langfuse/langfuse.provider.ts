import {Provider, ValueOrPromise} from '@loopback/core';

import {startActiveObservation, startObservation} from '@langfuse/tracing';
import {LLMCallbacks} from '../../../graphs';

/**
 * Observability handler bound to `AiIntegrationBindings.ObfHandler`.
 *
 * Replaces the LangChain `@langfuse/langchain` `CallbackHandler` and owns the
 * whole Langfuse trace via `@langfuse/tracing` (OpenTelemetry under the hood):
 *
 * - `traceRun` wraps a graph run or a node in a `startActiveObservation` span,
 *   set active in the OTEL context so everything it triggers nests beneath it —
 *   reproducing the pre-migration nested trace (trace → node observations →
 *   generations). The graph engine calls it at each graph/node boundary.
 * - `handleLLMStart`/`handleLLMEnd` record each model call as a `generation`
 *   observation with its prompt messages, response, and token usage; because
 *   the call runs inside the active node span, the generation nests correctly.
 *
 * All tracing is best-effort and never interferes with generation.
 */
export class LangfuseObfProvider implements Provider<LLMCallbacks> {
  value(): ValueOrPromise<LLMCallbacks> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const observations = new Map<string, any>();
    return {
      traceRun: <T>(name: string, input: unknown, fn: () => Promise<T>) =>
        startActiveObservation(
          name,
          async span => {
            span.update({input});
            const output = await fn();
            span.update({output});
            return output;
          },
          {asType: 'span'},
        ),
      handleLLMStart: (runId, modelName, input) => {
        try {
          observations.set(
            runId,
            startObservation(
              'llm-call',
              {
                model: modelName,
                input: input
                  ? {system: input.system, messages: input.messages}
                  : undefined,
              },
              {asType: 'generation'},
            ),
          );
        } catch {
          // best-effort tracing; ignore observability failures
        }
      },
      handleLLMEnd: (runId, result, output) => {
        try {
          const observation = observations.get(runId);
          observations.delete(runId);
          const usage = result.generations?.[0]?.[0]?.message?.usage_metadata;
          observation?.update?.({
            output: output?.content ?? output?.text,
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

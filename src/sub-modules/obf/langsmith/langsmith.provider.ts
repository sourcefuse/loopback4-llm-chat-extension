import {Provider, ValueOrPromise} from '@loopback/core';

import {registerTelemetry} from 'ai';
import {LangSmithTelemetry} from 'langsmith/experimental/vercel';
import {traceable} from 'langsmith/traceable';
import {LLMCallbacks} from '../../../graphs';

let registered = false;

/** LangSmith tracing is opt-in via the same env var LangChain used. */
function langsmithEnabled(): boolean {
  return process.env.LANGSMITH_TRACING === 'true';
}

/**
 * Registers the LangSmith AI SDK telemetry integration exactly once, using the
 * ambient LANGSMITH_* env (endpoint / api key / project). Idempotent; a no-op
 * when LangSmith tracing is disabled.
 */
function ensureRegistered(): void {
  if (registered || !langsmithEnabled()) {
    return;
  }
  registered = true;
  registerTelemetry(LangSmithTelemetry());
}

/**
 * Observability handler bound to `AiIntegrationBindings.ObfHandler` (via
 * `LangsmithComponent`).
 *
 * The LangSmith sibling of `LangfuseObfProvider` — same component+provider
 * shape, and, like it, uses its backend SDK (`langsmith`) directly. Before the
 * Mastra migration LangSmith "just worked from env" because LangChain shipped
 * its own exporter and wrapped each graph invocation in a run-tree; the AI SDK
 * has neither, so this restores it: `ensureRegistered` installs the LangSmith
 * telemetry integration (which captures every model call as a generation), and
 * `traceRun` wraps a graph run or node in a `traceable` so the run-tree groups.
 *
 * Only `traceRun` is implemented — the generations come from the telemetry
 * integration, so no per-call `handleLLMStart/End` is needed. A no-op
 * pass-through when `LANGSMITH_TRACING` is not `true`.
 */
export class LangsmithObfProvider implements Provider<LLMCallbacks> {
  value(): ValueOrPromise<LLMCallbacks> {
    return {
      traceRun: <T>(name: string, input: unknown, fn: () => Promise<T>) => {
        if (!langsmithEnabled()) {
          return fn();
        }
        ensureRegistered();
        // `traceable` records the wrapped function's argument as the run's
        // inputs and its return value as its outputs; ignore the arg inside and
        // delegate to `fn` so the caller keeps full control of what runs.
        const traced = traceable(async (_input: unknown) => fn(), {name});
        return traced(input);
      },
    };
  }
}

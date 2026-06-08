import debugFactory from 'debug';
import {
  BindingScope,
  inject,
  injectable,
  LifeCycleObserver,
  lifeCycleObserver,
} from '@loopback/core';
import type {Mastra} from '@mastra/core';
import {InternalBindings} from '../mastra/internal-bindings';

const debug = debugFactory('ai-integration:mastra-lifecycle');

/**
 * App-level lifecycle hook for the Mastra singleton. `start()` runs any
 * warm-up checks; `stop()` calls `mastra.shutdown()` to close storage pools,
 * stop background workers, and flush observability exporters cleanly.
 *
 * SINGLETON cannot inject REQUEST-scoped services — in-flight stream draining
 * is handled at the controller layer via `response.on('close')` and
 * AbortSignal propagation, not here.
 */
@lifeCycleObserver('mastra')
@injectable({scope: BindingScope.SINGLETON})
export class RuntimeLifecycleObserver implements LifeCycleObserver {
  constructor(@inject(InternalBindings.Mastra) private mastra: Mastra) {}

  async start(): Promise<void> {
    // Reserved for vector-index preflight, RLS check, etc.
    // Recommended boot-time safety gate for workingMemory + ResourceId.
  }

  async stop(): Promise<void> {
    try {
      await this.mastra.shutdown?.();
    } catch (err) {
      // Use the project debug channel rather than console.error so
      // shutdown noise stays under `DEBUG=ai-integration:*` like the
      // rest of the codebase. Process exits regardless; this is a
      // best-effort cleanup signal.
      debug('Mastra shutdown error: %o', err);
    }
  }
}

import {
  BindingScope,
  inject,
  injectable,
  LifeCycleObserver,
  lifeCycleObserver,
} from '@loopback/core';
import type {Mastra} from '@mastra/core';
import {AiIntegrationBindings} from '../keys';

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
export class MastraLifecycleObserver implements LifeCycleObserver {
  constructor(@inject(AiIntegrationBindings.Mastra) private mastra: Mastra) {}

  async start(): Promise<void> {
    // Reserved for vector-index preflight, RLS check, etc. (
    // recommended boot-time safety gate for workingMemory + ResourceId).
  }

  async stop(): Promise<void> {
    try {
      await this.mastra.shutdown?.();
    } catch (err) {
      console.error('Mastra shutdown error:', err);
    }
  }
}

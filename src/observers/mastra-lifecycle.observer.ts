import {
  BindingScope,
  inject,
  injectable,
  lifeCycleObserver,
  LifeCycleObserver,
} from '@loopback/core';
import {Mastra} from '@mastra/core/mastra';
import {AiIntegrationBindings} from '../keys';

@lifeCycleObserver('mastra')
@injectable({scope: BindingScope.SINGLETON})
export class MastraLifecycleObserver implements LifeCycleObserver {
  constructor(
    @inject(AiIntegrationBindings.Mastra)
    private readonly mastra: Mastra,
  ) {}

  async start(): Promise<void> {
    // Reserved for optional startup preflight checks.
  }

  async stop(): Promise<void> {
    try {
      await this.mastra.shutdown();
    } catch (error) {
      // Keep shutdown graceful even if Mastra emits a close-time error.
      console.error('Mastra shutdown error:', error);
    }
  }
}

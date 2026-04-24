import {inject, LifeCycleObserver} from '@loopback/core';
import {AiIntegrationBindings} from '../keys';
import {IMastraBridge} from './mastra-bridge.service';

/**
 * Initializes the Phase 0 bridge at application startup.
 */
export class MastraBridgeObserver implements LifeCycleObserver {
  constructor(
    @inject(AiIntegrationBindings.MastraBridge)
    private readonly mastraBridge: IMastraBridge,
  ) {}

  /**
   * Bootstraps bridge discovery once during app start.
   */
  async start(): Promise<void> {
    await this.mastraBridge.initialize();
  }
}

import {BindingScope, injectable} from '@loopback/core';
import {IRunRegistry} from '../../keys';

/**
 * Default in-process RunRegistry — single-pod safe. Multi-pod deployments
 * must bind a Redis-backed variant against AiIntegrationBindings.RunRegistry.
 * Section 8.2.1.
 */
@injectable({scope: BindingScope.SINGLETON})
export class InProcessRunRegistry implements IRunRegistry {
  private readonly map = new Map<string, {runId: string; expiresAt: number}>();
  private readonly ttlMs = 10 * 60 * 1000;

  async set(sessionId: string, runId: string): Promise<void> {
    this.map.set(sessionId, {runId, expiresAt: Date.now() + this.ttlMs});
  }

  async get(sessionId: string): Promise<string | undefined> {
    const entry = this.map.get(sessionId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.map.delete(sessionId);
      return undefined;
    }
    return entry.runId;
  }

  async delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId);
  }
}

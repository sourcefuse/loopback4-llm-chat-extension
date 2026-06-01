import {BindingScope, injectable} from '@loopback/core';
import {IRunRegistry} from '../../keys';

/**
 * Default in-process RunRegistry — single-pod safe. Multi-pod deployments
 * must bind a Redis-backed variant against MastraInternalBindings.RunRegistry.
 */
@injectable({scope: BindingScope.SINGLETON})
export class InProcessRunRegistry implements IRunRegistry {
  private readonly map = new Map<string, {runId: string; expiresAt: number}>();
  private readonly ttlMs = 10 * 60 * 1000;

  async set(sessionId: string, runId: string): Promise<void> {
    // Opportunistic sweep on every write — bounds the Map size for
    // long-lived processes where sessions are created but never
    // resumed (cleanup-on-get alone would let those entries linger).
    this.sweepExpired();
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

  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt < now) this.map.delete(key);
    }
  }
}

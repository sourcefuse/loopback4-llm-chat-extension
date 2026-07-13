import {expect, sinon} from '@loopback/testlab';
import type {Mastra} from '@mastra/core';
import {RuntimeLifecycleObserver} from '../../observers/mastra-lifecycle.observer';

/**
 * App-level lifecycle hook for the Mastra singleton. `stop()` is the only
 * code path that releases storage pools, background workers, and
 * observability exporters cleanly during graceful shutdown — a regression
 * here leaks pg connections + drops in-flight Langfuse spans on every
 * deploy. Lock the contract.
 */
describe('RuntimeLifecycleObserver (unit)', () => {
  afterEach(() => sinon.restore());

  it('stop() awaits mastra.shutdown() so storage pools are closed before process exit', async () => {
    const shutdown = sinon.stub().resolves();
    const observer = new RuntimeLifecycleObserver({
      shutdown,
    } as unknown as Mastra);

    await observer.stop();

    sinon.assert.calledOnce(shutdown);
  });

  it('stop() swallows shutdown errors so a faulty exporter cannot block process exit', async () => {
    // Production observation: a Langfuse flush rejecting on network
    // timeout would otherwise propagate out of @lifeCycleObserver and
    // hang the LB4 graceful-stop sequence. The catch is intentional.
    const shutdown = sinon.stub().rejects(new Error('exporter flush failed'));
    const observer = new RuntimeLifecycleObserver({
      shutdown,
    } as unknown as Mastra);

    await expect(observer.stop()).to.be.fulfilled();
    sinon.assert.calledOnce(shutdown);
  });

  it('stop() tolerates a Mastra instance with no shutdown method (older mastra versions)', async () => {
    // `mastra.shutdown?.()` short-circuits when the method is absent —
    // pinning a Mastra version that drops it must not crash shutdown.
    const observer = new RuntimeLifecycleObserver({} as unknown as Mastra);
    await expect(observer.stop()).to.be.fulfilled();
  });

  it('start() is a no-op so booting cannot fail on the lifecycle hook itself', async () => {
    // The class reserves start() for future warm-up checks; today it
    // must resolve cleanly so app.boot()/.start() never throws here.
    const observer = new RuntimeLifecycleObserver({} as unknown as Mastra);
    await expect(observer.start()).to.be.fulfilled();
  });
});

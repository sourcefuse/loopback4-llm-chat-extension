import {expect, sinon} from '@loopback/testlab';
import {InProcessRunRegistry} from '../../runtime/bridge/run-registry';

/**
 * Default single-pod RunRegistry. Powers HITL resume in v3.1 — a regression
 * in TTL / sweep semantics either drops still-resumable runs early or lets
 * the in-memory Map grow unbounded under long-lived processes. Lock both
 * sides.
 */
describe('InProcessRunRegistry (unit)', () => {
  // 10 minute TTL — matches the private constant in the implementation
  // (intentionally re-asserted here so a silent shortening is caught).
  const TTL_MS = 10 * 60 * 1000;
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers({now: 1_700_000_000_000});
  });

  afterEach(() => {
    clock.restore();
  });

  it('round-trips a runId for the supplied sessionId', async () => {
    const reg = new InProcessRunRegistry();
    await reg.set('thread-1', 'run-A');
    expect(await reg.get('thread-1')).to.equal('run-A');
  });

  it('returns undefined for an unknown sessionId', async () => {
    const reg = new InProcessRunRegistry();
    expect(await reg.get('never-set')).to.be.undefined();
  });

  it('delete removes the mapping immediately', async () => {
    const reg = new InProcessRunRegistry();
    await reg.set('thread-1', 'run-A');
    await reg.delete('thread-1');
    expect(await reg.get('thread-1')).to.be.undefined();
  });

  it('returns undefined and evicts after the TTL elapses (read-side sweep)', async () => {
    const reg = new InProcessRunRegistry();
    await reg.set('thread-1', 'run-A');
    clock.tick(TTL_MS + 1);

    expect(await reg.get('thread-1')).to.be.undefined();
    // Second read must still report missing — proves the read-side
    // delete actually evicted, not just returned undefined for one call.
    expect(await reg.get('thread-1')).to.be.undefined();
  });

  it('still returns the runId just before the TTL boundary', async () => {
    const reg = new InProcessRunRegistry();
    await reg.set('thread-1', 'run-A');
    clock.tick(TTL_MS - 1);
    expect(await reg.get('thread-1')).to.equal('run-A');
  });

  it('overwriting the same sessionId resets its TTL', async () => {
    // Mirrors the "user resumed within the window" path — without TTL
    // refresh, a second message in a long session would expire mid-flight.
    const reg = new InProcessRunRegistry();
    await reg.set('thread-1', 'run-A');
    clock.tick(TTL_MS - 1000);
    await reg.set('thread-1', 'run-B');
    clock.tick(TTL_MS - 1000);

    // Total elapsed since first set ≈ 2*TTL - 2s, but the refresh
    // resets the clock so this is still well inside the second window.
    expect(await reg.get('thread-1')).to.equal('run-B');
  });

  it('write-side sweep evicts other expired entries opportunistically', async () => {
    // The sweepExpired() pass on every set() bounds Map size for
    // long-lived processes where threads are created but never resumed.
    // Without this, expired entries would linger until each was read.
    const reg = new InProcessRunRegistry();
    await reg.set('stale-1', 'run-1');
    await reg.set('stale-2', 'run-2');
    clock.tick(TTL_MS + 1);

    // Triggers sweep — stale entries should be evicted as a side effect
    // even though we never `get` them.
    await reg.set('fresh', 'run-fresh');

    expect(await reg.get('stale-1')).to.be.undefined();
    expect(await reg.get('stale-2')).to.be.undefined();
    expect(await reg.get('fresh')).to.equal('run-fresh');
  });
});

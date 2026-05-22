import {expect} from '@loopback/testlab';
import {AsyncEventQueue} from '../../mastra/bridge/async-event-queue';

/**
 * Migration plan Section 7.7 promise: "1000 concurrent pushes followed
 * by a single consumer must observe exactly 1000 values in push order."
 * Plus the overflow + close-while-awaiting semantics that the SSE wire
 * contract depends on.
 */
describe('AsyncEventQueue', () => {
  it('preserves order across 1000 concurrent pushes', async () => {
    const q = new AsyncEventQueue<number>({maxSize: 2000});
    for (let i = 0; i < 1000; i++) q.push(i);
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out.length).to.equal(1000);
    for (let i = 0; i < 1000; i++) {
      expect(out[i]).to.equal(i);
    }
  });

  it('hard-closes on overflow instead of throwing', async () => {
    const q = new AsyncEventQueue<number>({maxSize: 3});
    q.push(1);
    q.push(2);
    q.push(3);
    // 4th push exceeds maxSize — should NOT throw; should close the
    // queue so the consumer drains existing then sees done=true.
    expect(() => q.push(4)).to.not.throwError();
    expect(q.isClosed).to.be.true();
    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    expect(seen).to.eql([1, 2, 3]);
  });

  it('silently drops push() after close()', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.close();
    expect(() => q.push(2)).to.not.throwError();
    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    expect(seen).to.eql([1]);
  });

  it('close() while a consumer is awaiting resolves with done=true', async () => {
    const q = new AsyncEventQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.close();
    const result = await pending;
    expect(result.done).to.be.true();
  });

  it('interleaved push/consume preserves order', async () => {
    const q = new AsyncEventQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const p1 = it.next();
    q.push(10);
    const r1 = await p1;
    expect(r1.value).to.equal(10);
    q.push(20);
    q.push(30);
    q.close();
    const seen: number[] = [];
    let next;
    while (!(next = await it.next()).done) seen.push(next.value);
    expect(seen).to.eql([20, 30]);
  });

  it('isClosed reports state correctly', () => {
    const q = new AsyncEventQueue<number>();
    expect(q.isClosed).to.be.false();
    q.close();
    expect(q.isClosed).to.be.true();
  });

  it('close() is idempotent', () => {
    const q = new AsyncEventQueue<number>();
    q.close();
    expect(() => q.close()).to.not.throwError();
    expect(q.isClosed).to.be.true();
  });
});

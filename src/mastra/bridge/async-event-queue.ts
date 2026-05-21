/**
 * Single-producer-or-multiple-producer / single-consumer async queue used to
 * funnel SSE events from the WorkflowRunner pre-processing block, the Mastra
 * agent fullStream pump task, and tool-side eventWriter calls into a single
 * ordered iterator that the controller consumes (Section 7.7).
 *
 * Critical properties:
 * - Push order is preserved across concurrent producers (atomic shift/push).
 * - `maxSize` provides hard backpressure: overflow throws rather than dropping
 *   events silently, which would corrupt the SSE wire contract.
 * - Array-of-resolvers (NOT single slot): waiters queue up so 1000 concurrent
 *   pushes followed by a single consumer observe exactly 1000 values in order.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;
  private readonly maxSize: number;

  constructor(opts: {maxSize?: number} = {}) {
    this.maxSize = opts.maxSize ?? 10000;
  }

  push(value: T): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxSize) {
      throw new Error(`AsyncEventQueue overflow (max ${this.maxSize})`);
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({value, done: false});
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length) {
      this.resolvers.shift()!({value: undefined as never, done: true});
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length) {
          return Promise.resolve({value: this.queue.shift()!, done: false});
        }
        if (this.closed) {
          return Promise.resolve({value: undefined as never, done: true});
        }
        return new Promise(resolve => this.resolvers.push(resolve));
      },
    };
  }
}

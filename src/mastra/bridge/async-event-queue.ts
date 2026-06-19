/**
 * Single-producer-or-multiple-producer / single-consumer async queue used to
 * funnel SSE events from the WorkflowRunner pre-processing block, the Mastra
 * agent fullStream pump task, and tool-side eventWriter calls into a single
 * ordered iterator that the controller consumes.
 *
 * Critical properties:
 * - Push order is preserved across concurrent producers (atomic shift/push).
 * - `maxSize` triggers hard-close on overflow rather than throwing. Tool-side
 *   `push()` calls run inside Mastra's tool harness; a throw there propagates
 *   up as a tool failure and the SSE consumer sees the stream stop with no
 *   Error event. Hard-close instead lets the consumer drain whatever already
 *   queued and then sees `done: true` cleanly.
 * - Post-close `push()` is silently dropped (no throw).
 * - Array-of-resolvers (NOT single slot): waiters queue up so 1000 concurrent
 *   pushes followed by a single consumer observe exactly 1000 values in order.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closedFlag = false;
  private readonly maxSize: number;
  private readonly overflowValue?: T;

  constructor(opts: {maxSize?: number; overflowValue?: T} = {}) {
    this.maxSize = opts.maxSize ?? 10000;
    this.overflowValue = opts.overflowValue;
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  push(value: T): void {
    if (this.closedFlag) return;
    if (this.queue.length >= this.maxSize) {
      // Hard-close instead of throw — see class-level comment for why.
      // Before closing, emit the overflow sentinel (if provided) so the
      // consumer sees an explicit Error event rather than a silent done:true.
      // Without this, an overflow looks identical to a normal stream end —
      // the client gets a clean EOF with a partial answer and no signal that
      // events were dropped.
      if (this.overflowValue !== undefined) {
        this.push(this.overflowValue);
      }
      this.close();
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({value, done: false});
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
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
        if (this.closedFlag) {
          return Promise.resolve({value: undefined as never, done: true});
        }
        return new Promise(resolve => this.resolvers.push(resolve));
      },
    };
  }
}

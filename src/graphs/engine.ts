/**
 * Small runtime helpers backing the Mastra-based graph engine (see
 * `./base.graph`): the shared passthrough step schema, the reducer that merges a
 * node's returned partial into graph state (reproducing LangGraph's channel
 * reducers — `messages` appends, every other field replaces), and an async
 * queue used to surface a node's custom stream events to the caller.
 */
import {z} from 'zod';
import type {ModelMessage} from './messages';

/** Step input/output schema — data flows through Mastra `state`, not I/O. */
export const passthroughSchema = z.object({}).catchall(z.any());

/** Appends new messages onto the existing list (LangGraph messages-channel). */
export function messagesReducer(
  existing: ModelMessage[],
  update: ModelMessage[],
): ModelMessage[] {
  return [...existing, ...update];
}

/**
 * Merges a node's returned partial into the current graph state, honouring the
 * `messages` append reducer. Only keys present in `partial` are updated (keys
 * set to `undefined` clear their channel, matching the reducer contract).
 */
export function mergeState<T extends object>(
  prev: T,
  partial: Partial<T> | undefined,
): T {
  if (!partial || typeof partial !== 'object') {
    return prev;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const next: any = {...prev};
  for (const key of Object.keys(partial)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = (partial as any)[key];
    if (key === 'messages') {
      next.messages = messagesReducer(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (prev as any).messages ?? [],
        (value ?? []) as ModelMessage[],
      );
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * A minimal push/pull async queue. Nodes push custom stream events via
 * `config.writer`; the consumer (`GenerationService`) iterates them. `close`
 * ends iteration; `fail` ends it by throwing.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;
  private error?: unknown;

  push(item: T): void {
    if (this.done) {
      return;
    }
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({value: item, done: false});
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.done = true;
    while (this.resolvers.length) {
      this.resolvers.shift()!({value: undefined as never, done: true});
    }
  }

  fail(error: unknown): void {
    this.error = error;
    this.close();
  }

  /** Rethrows a stored failure at end-of-stream (no-op on a clean close). */
  private _throwIfFailed(): void {
    if (this.error) {
      throw this.error;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.done) {
        this._throwIfFailed();
        return;
      }
      const result = await new Promise<IteratorResult<T>>(resolve =>
        this.resolvers.push(resolve),
      );
      if (result.done) {
        this._throwIfFailed();
        return;
      }
      yield result.value;
    }
  }
}

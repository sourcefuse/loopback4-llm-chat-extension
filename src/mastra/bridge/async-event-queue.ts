import {LLMStreamEvent} from '../../graphs/event.types';

/**
 * AsyncEventQueue — a lightweight in-process event queue for real-time SSE delivery.
 *
 * Used to bridge between Mastra agent callbacks (which run inside agent internals and
 * cannot access the step's `writer`) and the WorkflowRunner's event-forwarding loop.
 *
 * Architecture:
 *   1. WorkflowRunner stores an AsyncEventQueue in RequestContext before workflow run.
 *   2. AgentReasoningStep's onStepFinish / tool-call callbacks push events to the queue.
 *   3. WorkflowRunner reads from the queue concurrently and sends events to ITransport.
 *   4. After workflow completes, `close()` signals the consumer to stop iterating.
 */
export class AsyncEventQueue implements AsyncIterable<LLMStreamEvent> {
  private readonly _queue: LLMStreamEvent[] = [];
  private _resolve: (() => void) | null = null;
  private _closed = false;

  /**
   * Push an event into the queue.
   * Synchronous; wakes any waiting consumer.
   */
  push(event: LLMStreamEvent): void {
    if (this._closed) return;
    this._queue.push(event);
    this._resolve?.();
    this._resolve = null;
  }

  /**
   * Signal that no more events will be pushed.
   * The async iterator will complete after all buffered events are consumed.
   */
  close(): void {
    this._closed = true;
    this._resolve?.();
    this._resolve = null;
  }

  /**
   * Returns true when the queue is closed and all events have been consumed.
   */
  get isDrained(): boolean {
    return this._closed && this._queue.length === 0;
  }

  /**
   * Async iterator — yields events as they arrive.
   * Suspends (awaits) when the queue is empty and not yet closed.
   */
  [Symbol.asyncIterator](): AsyncIterator<LLMStreamEvent> {
    return {
      next: async (): Promise<IteratorResult<LLMStreamEvent>> => {
        // Spin until an event is available or the queue is closed
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (this._queue.length > 0) {
            return {value: this._queue.shift()!, done: false};
          }
          if (this._closed) {
            return {value: undefined as unknown as LLMStreamEvent, done: true};
          }
          // Wait for next push or close
          await new Promise<void>(resolve => {
            this._resolve = resolve;
          });
        }
      },
    };
  }
}

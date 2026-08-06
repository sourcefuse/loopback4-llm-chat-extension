import {createStep} from '@mastra/core/workflows';
import {Context, inject} from '@loopback/core';
import {z} from 'zod';
import {GRAPH_NODE_NAME} from '../constant';
import {AsyncEventQueue, mergeState, passthroughSchema} from './engine';
import {LLMStreamEvent} from './event.types';
import {GraphTool, IGraphNode, LLMCallbacks, RunnableConfig} from './types';

/** Run-scoped inputs threaded into a workflow run (REQUEST-scoped instance). */
export interface GraphRuntime {
  signal?: AbortSignal;
  callbacks?: LLMCallbacks[];
  configurable?: RunnableConfig['configurable'];
  sink?: (event: LLMStreamEvent) => void;
}

/** The subset of a committed Mastra workflow this engine drives. */
interface RunHandle {
  start(args: {inputData: unknown; initialState: unknown}): Promise<unknown>;
  cancel(): Promise<void>;
}
interface CommittedWorkflow {
  createRun(): Promise<RunHandle>;
}

/**
 * Base class for every graph (workflow). Node discovery still happens through
 * the `@graphNode` tag binding; `build()` composes the DI-resolved nodes into a
 * real Mastra workflow. A single graph-state object flows through the workflow
 * via Mastra `state`/`setState`; each node keeps its `execute(state, config)`
 * signature and its returned partial is merged with the graph's reducers.
 */
export abstract class BaseGraph<T extends object> {
  @inject.context()
  protected context: Context;

  /** The graph's shared-state zod schema, used as the Mastra `stateSchema`. */
  protected abstract stateSchema: z.ZodType<T>;

  // Run-scoped runtime, populated before each run.
  protected _sink?: (event: LLMStreamEvent) => void;
  protected _signal?: AbortSignal;
  protected _callbacks: LLMCallbacks[] = [];
  protected _configurable: RunnableConfig['configurable'] = {};
  protected _latestState?: T;

  // Returns a committed Mastra workflow (typed `unknown` — a committed workflow
  // is itself thenable via its builder `.then`, so it must never be awaited or
  // returned through a promise, and run helpers narrow it to `CommittedWorkflow`).
  abstract build(): unknown;

  protected _prepareRuntime(runtime: GraphRuntime): void {
    this._sink = runtime.sink;
    this._signal = runtime.signal;
    this._callbacks = runtime.callbacks ?? [];
    this._configurable = runtime.configurable ?? {};
  }

  protected buildConfig(abortSignal?: AbortSignal): RunnableConfig {
    return {
      writer: this._sink,
      signal: abortSignal ?? this._signal,
      callbacks: this._callbacks,
      configurable: this._configurable,
    };
  }

  protected async _resolveNode(key: string): Promise<IGraphNode<T>> {
    const bindings = this.context.findByTag({
      [GRAPH_NODE_NAME]: key,
    });
    if (bindings.length === 0) {
      throw new Error(`Node with key ${key} not found`);
    }
    if (bindings.length > 1) {
      throw new Error(`Multiple nodes found with key ${key}`);
    }
    return this.context.get<IGraphNode<T>>(bindings[0].key);
  }

  /** Back-compat: resolves a node and returns its bound `execute`. */
  protected async _getNodeFn(key: string) {
    const node = await this._resolveNode(key);
    return node.execute.bind(node);
  }

  private async _applyResult(
    state: T,
    result: Partial<T>,
    setState: (s: T) => Promise<void>,
  ): Promise<void> {
    const merged = mergeState(state, result);
    this._latestState = merged;
    await setState(merged);
  }

  /** Wraps a single DI-resolved node as a sequential Mastra step. */
  protected _toStep(key: string) {
    return createStep({
      id: key,
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
      execute: async ({state, setState, abortSignal}) => {
        const node = await this._resolveNode(key);
        const config = this.buildConfig(abortSignal);
        const result = (await node.execute(state, config)) as Partial<T>;
        await this._applyResult(state, result, setState);
        return {};
      },
    });
  }

  /**
   * Runs several nodes concurrently and merges their partials — reproducing
   * LangGraph's parallel superstep + channel-reducer fan-in deterministically
   * (and avoiding concurrent `setState` races).
   */
  protected _toParallelStep(id: string, keys: string[]) {
    return createStep({
      id,
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
      execute: async ({state, setState, abortSignal}) => {
        const config = this.buildConfig(abortSignal);
        const nodes = await Promise.all(keys.map(k => this._resolveNode(k)));
        const results = await Promise.all(
          nodes.map(n => n.execute(state, config)),
        );
        let merged = state;
        for (const result of results) {
          merged = mergeState(merged, result as Partial<T>);
        }
        this._latestState = merged;
        await setState(merged);
        return {};
      },
    });
  }

  /** Wraps an inline `(state, config) => partial` as a step (routing/merge nodes). */
  protected _toFnStep(
    id: string,
    fn: (state: T, config: RunnableConfig) => Promise<Partial<T>> | Partial<T>,
  ) {
    return createStep({
      id,
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
      execute: async ({state, setState, abortSignal}) => {
        const config = this.buildConfig(abortSignal);
        const result = await fn(state, config);
        await this._applyResult(state, result, setState);
        return {};
      },
    });
  }

  /**
   * Runs the graph to completion and returns the final state. Public equivalent
   * of the old compiled-graph `.invoke(state)` — used when one graph drives
   * another (e.g. the visualization graph invoking the db-query graph).
   */
  async invoke(initialState: Partial<T>, config?: RunnableConfig): Promise<T> {
    return this._runToCompletion(initialState as T, {
      signal: config?.signal,
      callbacks: config?.callbacks,
      configurable: config?.configurable,
      sink: config?.writer,
    });
  }

  /** Runs the workflow to completion and returns the final graph state. */
  protected async _runToCompletion(
    initialState: T,
    runtime: GraphRuntime = {},
  ): Promise<T> {
    this._prepareRuntime(runtime);
    this._latestState = initialState;
    const workflow = this.build() as CommittedWorkflow;
    const run = await workflow.createRun();
    if (this._signal) {
      this._signal.addEventListener('abort', () => {
        run.cancel().catch(() => {
          // ignore cancellation errors
        });
      });
    }
    // `start` runs the workflow to completion (`startAsync` is fire-and-forget).
    await run.start({inputData: {}, initialState});
    return this._latestState;
  }

  /**
   * Runs the workflow and streams the custom events its nodes emit. Returns an
   * async iterable of `LLMStreamEvent` consumed by `GenerationService` — the
   * replacement for `graph.stream({streamMode: 'custom'})`.
   */
  protected async streamEvents(
    initialState: T,
    runtime: GraphRuntime = {},
  ): Promise<AsyncEventQueue<LLMStreamEvent>> {
    const queue = new AsyncEventQueue<LLMStreamEvent>();
    this._prepareRuntime({...runtime, sink: event => queue.push(event)});
    this._latestState = initialState;
    const workflow = this.build() as CommittedWorkflow;
    const run = await workflow.createRun();
    if (this._signal) {
      this._signal.addEventListener('abort', () => {
        run.cancel().catch(() => {
          // ignore cancellation errors
        });
      });
    }
    // Run to completion in the background; nodes push events to the queue via
    // `config.writer` as steps execute, and we close the queue when done.
    // (`start` executes the steps; `startAsync` would return before they run.)
    run.start({inputData: {}, initialState}).then(
      () => queue.close(),
      (error: unknown) => queue.fail(error),
    );
    return queue;
  }

  /**
   * Exposes this graph as a tool for the chat LLM. Replaces LangGraph's
   * `graph.asTool(...)`; running the tool executes the sub-workflow to
   * completion, propagating the parent run's stream sink, callbacks and abort
   * signal so nested events reach the same stream.
   */
  asTool(
    config: RunnableConfig,
    meta: {name: string; description: string; schema: GraphTool['schema']},
  ): GraphTool {
    return {
      name: meta.name,
      description: meta.description,
      schema: meta.schema,
      invoke: async (args: Record<string, unknown>) =>
        this._runToCompletion(args as unknown as T, {
          signal: config.signal,
          callbacks: config.callbacks,
          configurable: config.configurable,
          sink: config.writer,
        }),
    };
  }
}

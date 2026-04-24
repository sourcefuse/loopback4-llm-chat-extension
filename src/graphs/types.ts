import {AIMessage, HumanMessage, ToolMessage} from '@langchain/core/messages';
import {AnyObject, Command} from '@loopback/repository';

/**
 * Runtime-agnostic execution config that can carry stream writers and runtime metadata.
 */
export type RunnableConfig = {
  configurable?: Record<string, unknown>;
  signal?: AbortSignal;
  writer?: (chunk: unknown) => void;
};

/**
 * Node step execution function compatible with Mastra-like step execution.
 */
export type GraphStepExecuteFn<T extends object> = (
  state: T,
  config: RunnableConfig,
) => Promise<Partial<T> | Command>;

/**
 * Minimal step contract required by Phase 1 interface migration.
 */
export interface IGraphStep<T extends object> {
  execute: GraphStepExecuteFn<T>;
}

/**
 * Graph node contract supporting both legacy `execute` and Mastra-style `createStep`.
 */
export interface IGraphNode<T extends object> {
  createStep?(config?: RunnableConfig): Promise<IGraphStep<T>> | IGraphStep<T>;
  execute?: GraphStepExecuteFn<T>;
}

export type SavedMessage = HumanMessage | AIMessage | ToolMessage;

/**
 * Minimal runtime tool contract shared across LangGraph and Mastra-compatible tooling.
 */
export interface IRuntimeTool<TResult = unknown, TArgs = unknown> {
  name: string;
  invoke(input: TArgs): Promise<TResult>;
}

/**
 * Tool contract supporting Mastra-style `createTool` and legacy `build` for compatibility.
 */
export interface IGraphTool {
  key: string;
  createTool?(config: RunnableConfig): Promise<IRuntimeTool>;
  /**
   * @deprecated Use `createTool()`.
   */
  build?(config: RunnableConfig): Promise<IRuntimeTool>;
  getValue?(result: unknown): string;
  getMetadata?(result: unknown): AnyObject;
  needsReview?: boolean;
}

/**
 * Resolves the executable function for a node, preferring `execute` and falling back to `createStep`.
 */
export async function resolveNodeExecution<T extends object>(
  node: IGraphNode<T>,
): Promise<GraphStepExecuteFn<T>> {
  if (node.execute) {
    return node.execute.bind(node);
  }

  if (node.createStep) {
    const step = await node.createStep();
    return step.execute.bind(step);
  }

  throw new Error('Node must implement either execute() or createStep().');
}

/**
 * Resolves a runtime tool from the migrated contract while preserving legacy fallback.
 */
export async function resolveGraphTool(
  tool: IGraphTool,
  config: RunnableConfig,
): Promise<IRuntimeTool> {
  if (tool.createTool) {
    return tool.createTool(config);
  }

  if (tool.build) {
    return tool.build(config);
  }

  throw new Error(`Tool ${tool.key} does not implement createTool().`);
}

export type IGraphDirectEdge = {
  from: string;
  to: string;
};

export type IGraphConditionalEdge<T extends object> = {
  from: string;
  toList: string[];
  branchingFunction(state: T): string;
};

export type IGraphEdge<T extends object> =
  | IGraphDirectEdge
  | IGraphConditionalEdge<T>;

export enum ToolStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

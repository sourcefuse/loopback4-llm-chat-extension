/**
 * Shared tool and runtime-config types used by both the Mastra workflow steps
 * and the public extension API.
 *
 * Moved from src/graphs/types.ts — no @langchain/* imports.
 */
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
 * Node step execution function signature.
 */
export type GraphStepExecuteFn<T extends object> = (
  state: T,
  config: RunnableConfig,
) => Promise<Partial<T> | Command>;

/**
 * Minimal step contract.
 */
export interface IGraphStep<T extends object> {
  execute: GraphStepExecuteFn<T>;
}

/**
 * Graph node contract supporting Mastra-style `createStep`.
 */
export interface IGraphNode<T extends object> {
  createStep?(config?: RunnableConfig): Promise<IGraphStep<T>> | IGraphStep<T>;
  execute?: GraphStepExecuteFn<T>;
}

/**
 * Minimal runtime tool contract shared across the Mastra execution path.
 */
export interface IRuntimeTool<TResult = unknown, TArgs = unknown> {
  name: string;
  description?: string;
  schema?: unknown;
  invoke(input: TArgs): Promise<TResult>;
}

/**
 * Tool contract supporting Mastra-style `createTool` and legacy `build` for compatibility.
 */
export interface IGraphTool {
  key: string;
  description?: string;
  inputSchema?: unknown;
  createTool?(config: RunnableConfig): Promise<IRuntimeTool>;
  /** @deprecated Use `createTool()`. */
  build?(config: RunnableConfig): Promise<IRuntimeTool>;
  getValue?(result: unknown): string;
  getMetadata?(result: unknown): AnyObject;
  needsReview?: boolean;
}

/**
 * Resolves a runtime tool from the contract while preserving legacy fallback.
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

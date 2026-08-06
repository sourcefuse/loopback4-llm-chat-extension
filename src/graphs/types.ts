import {AnyObject, Command} from '@loopback/repository';
import {ZodType} from 'zod';
import {LLMStreamEvent} from './event.types';
import type {ModelMessage} from './messages';

/** A token-usage result surfaced to callbacks (kept shaped for TokenCounter). */
export interface LLMEndResult {
  generations: Array<
    Array<{
      message: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        usage_metadata?: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          input_tokens?: number;
          // eslint-disable-next-line @typescript-eslint/naming-convention
          output_tokens?: number;
        };
      };
    }>
  >;
}

/**
 * Observation hooks fired around each LLM call. Replaces the LangChain
 * callbacks array; `TokenCounter` and the Langfuse `ObfHandler` implement it.
 */
export interface LLMCallbacks {
  handleLLMStart?: (runId: string, modelName: string) => void;
  handleLLMEnd?: (runId: string, result: LLMEndResult) => void;
}

/**
 * Per-run configuration handed to every node's `execute`. Replaces
 * `LangGraphRunnableConfig`; `writer` streams custom events, `signal` carries
 * cancellation, `callbacks` receive LLM token usage, `configurable` carries the
 * thread id.
 */
export type RunnableConfig = {
  writer?: (event: LLMStreamEvent) => void;
  signal?: AbortSignal;
  callbacks?: LLMCallbacks[];
  configurable?: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    thread_id?: string;
    [key: string]: unknown;
  };
};

export interface IGraphNode<T extends object> {
  execute: (state: T, config: RunnableConfig) => Promise<Partial<T> | Command>;
}

export type SavedMessage = ModelMessage;

/**
 * A tool usable by the chat LLM. Returned by `IGraphTool.build`; converted to an
 * AI SDK tool for model calls and invoked directly by the run-tool node.
 */
export interface GraphTool {
  name: string;
  description: string;
  schema: ZodType | AnyObject;
  // Tool results are heterogeneous (a dataset-state object or a plain string),
  // so the return is dynamic — expressed via AnyObject indexing to stay
  // consistent with the codebase's `AnyObject` convention.
  invoke(args: AnyObject): Promise<AnyObject[string]> | AnyObject[string];
}

export interface IGraphTool {
  key: string;
  build(config: RunnableConfig): Promise<GraphTool>;
  getValue?(result: Record<string, string>): string;
  getMetadata?(result: Record<string, string>): AnyObject;
  needsReview?: boolean;
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
  IGraphDirectEdge | IGraphConditionalEdge<T>;

export enum ToolStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

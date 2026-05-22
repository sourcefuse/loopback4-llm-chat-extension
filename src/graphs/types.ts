import {AIMessage, HumanMessage, ToolMessage} from '@langchain/core/messages';
import {RunnableToolLike} from '@langchain/core/runnables';
import {StructuredToolInterface} from '@langchain/core/tools';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {Tool} from '@mastra/core/tools';
import {AnyObject, Command} from '@loopback/repository';
import {LLMStreamEvent} from './event.types';

export type {LangGraphRunnableConfig} from '@langchain/langgraph';

export type RunnableConfig = LangGraphRunnableConfig & {
  writer?: (event: LLMStreamEvent) => void;
};

export interface IGraphNode<T extends object> {
  execute: (state: T, config: RunnableConfig) => Promise<Partial<T> | Command>;
}

export type SavedMessage = HumanMessage | AIMessage | ToolMessage;

export interface IGraphTool {
  key: string;
  build(
    config: LangGraphRunnableConfig,
  ): Promise<StructuredToolInterface | RunnableToolLike>;
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
  | IGraphDirectEdge
  | IGraphConditionalEdge<T>;

export enum ToolStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  AwaitingApproval = 'awaiting_approval',
}

// Mastra-shaped tool interface. Coexists with v2 IGraphTool during P1 transition.
// In P3 (LangGraph deletion), IGraphTool is replaced by this shape and renamed back to IGraphTool.
export interface IMastraGraphTool {
  key: string;
  requireApproval?: boolean;
  build(): Tool;
  getValue?(result: Record<string, unknown>): string;
  getMetadata?(result: Record<string, unknown>): AnyObject;
}

/**
 * Registry shape consumed by WorkflowRunner. Mirrors the legacy `ToolStore`
 * in src/types.ts but holds IMastraGraphTool instances.
 */
export type MastraToolStore = {
  list: IMastraGraphTool[];
  map?: Record<string, IMastraGraphTool>;
};

import {AIMessage, HumanMessage, ToolMessage} from '@langchain/core/messages';
import {RunnableToolLike} from '@langchain/core/runnables';
import {StructuredToolInterface} from '@langchain/core/tools';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {AnyObject, Command} from '@loopback/repository';
import {LLMStreamEvent} from './event.types';

export type RunnableConfig = LangGraphRunnableConfig & {
  writer?: (event: LLMStreamEvent) => void;
};

export interface IGraphNode<T extends object> {
  execute: (state: T, config: RunnableConfig) => Promise<T | Command>;
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
}

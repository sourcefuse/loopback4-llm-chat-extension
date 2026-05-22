import {AIMessage, HumanMessage, ToolMessage} from '@langchain/core/messages';
import {RunnableToolLike} from '@langchain/core/runnables';
import {StructuredToolInterface} from '@langchain/core/tools';
import {Tool} from '@mastra/core/tools';
import type {AnyObject} from '@loopback/repository';

/**
 * Legacy LangChain-shaped tool interface. Kept for any downstream
 * consumer still injecting `AiIntegrationBindings.Tools`. The Mastra
 * code path uses `IMastraGraphTool` and `MastraToolStore` below.
 */
export interface IGraphTool {
  key: string;
  build(): Promise<StructuredToolInterface | RunnableToolLike>;
  getValue?(result: Record<string, string>): string;
  getMetadata?(result: Record<string, string>): AnyObject;
  needsReview?: boolean;
}

export type SavedMessage = HumanMessage | AIMessage | ToolMessage;

export enum ToolStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  AwaitingApproval = 'awaiting_approval',
}

/**
 * Mastra-shaped tool interface used by the Mastra createTool wrappers and
 * consumed by WorkflowRunner.buildAgent() via MastraToolStore.
 */
export interface IMastraGraphTool {
  key: string;
  build(): Tool;
  getValue?(result: Record<string, unknown>): string;
  getMetadata?(result: Record<string, unknown>): AnyObject;
  // `requireApproval` arrives in v3.1 alongside the ApprovalController
  // PR. Until the resume side is wired, declaring it on the interface
  // misleads consumers into thinking HITL works end-to-end.
}

/**
 * Registry shape consumed by WorkflowRunner. Mirrors the legacy `ToolStore`
 * in src/types.ts but holds IMastraGraphTool instances.
 */
export type MastraToolStore = {
  list: IMastraGraphTool[];
  map?: Record<string, IMastraGraphTool>;
};

import {Tool} from '@mastra/core/tools';
import type {AnyObject} from '@loopback/repository';

export enum ToolStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  AwaitingApproval = 'awaiting_approval',
}

/**
 * Mastra-shaped tool interface used by the Mastra createTool wrappers and
 * consumed by WorkflowRunner (built into the per-request tool map) via
 * MastraToolStore.
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
};

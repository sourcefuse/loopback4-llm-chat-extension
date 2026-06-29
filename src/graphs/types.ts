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
 * ToolStore.
 */
export interface IGraphTool {
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
 * in src/types.ts but holds IGraphTool instances.
 *
 * `map` is keyed by each tool's `key` so consumers (and the runner) can look a
 * tool up by name without scanning `list` — restoring the v2 `ToolStore.map`
 * the chat graph relied on. It is OPTIONAL so existing providers that build
 * only `{list}` keep compiling; the bundled DefaultToolsProvider always
 * populates it, and `toolMap()` derives it from `list` when absent.
 */
export type ToolStore = {
  list: IGraphTool[];
  map?: Record<string, IGraphTool>;
};

/**
 * Resolve a tool registry's `key → tool` map, deriving it from `list` when a
 * provider didn't supply one. Lets the library look tools up by name without
 * forcing every consumer-built ToolStore to include `map`.
 */
export function toolMap(store: ToolStore): Record<string, IGraphTool> {
  if (store.map) return store.map;
  const map: Record<string, IGraphTool> = {};
  for (const tool of store.list) {
    if (tool?.key) map[tool.key] = tool;
  }
  return map;
}

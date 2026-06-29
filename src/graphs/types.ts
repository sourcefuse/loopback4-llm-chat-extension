import {Tool} from '@mastra/core/tools';
import type {AnyObject} from '@loopback/repository';
import type {Mastra} from '@mastra/core';
import type {RequestContext} from '@mastra/core/request-context';
import type {TracingContext} from '@mastra/core/observability';

/**
 * The Mastra step `execute` argument, as seen by a workflow step. The shell
 * (see {@link makeStepShell}) forwards Mastra's real execute context unchanged,
 * so a step body reads `inputData` (the previous step's typed output),
 * `requestContext` (request-scoped runtime data + the step resolver),
 * `tracingContext`, and — for fan-in steps — `getStepResult` / `getInitData`.
 *
 * `requestContext` is typed `RequestContext<any>` because Mastra's
 * RequestContext is INVARIANT in its shape generic: a step that narrows it to
 * MastraRc (= RequestContext<MastraRcShape>) is otherwise neither assignable-to
 * nor -from RequestContext<unknown>. `any` is the standard escape hatch for
 * that invariant-generic seam; each step body still uses the typed accessors.
 */
export interface WorkflowStepCtx<TIn = unknown> {
  inputData: TIn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requestContext: RequestContext<any>;
  tracingContext?: TracingContext;
  getStepResult(stepId: string): unknown;
  getInitData?(): unknown;
  // Present on Mastra's step execute ctx; used by steps that invoke a nested
  // workflow (e.g. call-query-generation runs generateQueryWorkflow).
  mastra?: Mastra;
}

/**
 * DI-resolved workflow step (the Mastra-named successor of the LangGraph
 * `IGraphNode`). A `@step(key)`-decorated class implements this; the workflow
 * never references the concrete class — it resolves the instance by tag at run
 * time (see {@link makeStepShell} + WorkflowRunner.resolveWorkflowStep), so a
 * host app overrides a step purely by rebinding the tagged class.
 */
export interface IWorkflowStep<TIn = unknown, TOut = unknown> {
  execute(ctx: WorkflowStepCtx<TIn>): Promise<TOut>;
}

/**
 * Resolve a `@step(key)`-tagged class instance from the LB4 container. Threaded
 * into the Mastra RequestContext by WorkflowRunner so a committed step shell
 * can fetch its DI-backed implementation per request. Mirrors
 * BaseGraph._getNodeFn (tag lookup → context.get).
 */
export type StepResolver = (key: string) => Promise<IWorkflowStep>;

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

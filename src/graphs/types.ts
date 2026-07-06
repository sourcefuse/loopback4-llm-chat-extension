import {Tool} from '@mastra/core/tools';
import type {AnyObject} from '@loopback/repository';
import type {Mastra} from '@mastra/core';
import type {RequestContext} from '@mastra/core/request-context';
import type {TracingContext} from '@mastra/core/observability';

/**
 * The Mastra step `execute` argument, as seen by a workflow step. The shell
 * (see {@link makeNodeShell}) forwards Mastra's real execute context unchanged,
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
export interface GraphNodeCtx<TIn = unknown> {
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
 * `IGraphNode`). A `@graphNode(key)`-decorated class implements this; the workflow
 * never references the concrete class — it resolves the instance by tag at run
 * time (see {@link makeNodeShell} + WorkflowRunner.resolveGraphNode), so a
 * host app overrides a step purely by rebinding the tagged class.
 */
export interface IGraphNode<TIn = unknown, TOut = unknown> {
  execute(ctx: GraphNodeCtx<TIn>): Promise<TOut>;
}

/**
 * Resolve a `@graphNode(key)`-tagged class instance from the LB4 container. Threaded
 * into the Mastra RequestContext by WorkflowRunner so a committed step shell
 * can fetch its DI-backed implementation per request. Mirrors
 * BaseGraph._getNodeFn (tag lookup → context.get).
 */
export type NodeResolver = (key: string) => Promise<IGraphNode>;

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

// `ToolStore` + `toolMap()` live in `src/types.ts` (as in the LangGraph
// version), re-exported from the package root barrel.

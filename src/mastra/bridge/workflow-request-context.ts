import type {RequestContext} from '@mastra/core/request-context';
import type {Agent, MastraLanguageModel} from '@mastra/core/agent';
import type {MastraMemory} from '@mastra/core/memory';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import type {AIIntegrationConfig, MastraToolStore} from '../../types';
import type {AsyncEventQueue} from './async-event-queue';
import type {TokenUsageAccumulator} from './token-usage-accumulator';

/**
 * Typed interface for all values stored in Mastra RequestContext.
 *
 * Using `RequestContext<WorkflowRequestContext>` enables fully typed `.get()` and `.set()`
 * calls throughout all workflow steps and the ChatReasoningAgent — zero `any` casts needed.
 *
 * All keys follow the snake_case convention matching the RequestContext.set() calls in
 * WorkflowRunner.executeChatWorkflow().
 */
export interface WorkflowRequestContext {
  /** Primary LLM used for chat reasoning (Agent reasoning loop) */
  mastraChatLlm: MastraLanguageModel;
  /** LLM used for file summarisation (falls back to mastraChatLlm if not set) */
  mastraFileLlm: MastraLanguageModel;
  /** Shared Mastra memory instance used for thread persistence and recall */
  mastraMemory: MastraMemory;
  /** Request-scoped chat agent instance resolved from Mastra singleton */
  chatReasoningAgent: Agent;
  /** Mastra-native tool registry for the chat Agent */
  mastraTools: MastraToolStore;
  /** AI integration config (optional — may be undefined if not bound) */
  aiConfig: AIIntegrationConfig | Record<string, never>;
  /** System context strings to prepend to the system prompt */
  systemContext: string[] | undefined;
  /** Per-request token usage accumulator */
  tokenUsageAccumulator: TokenUsageAccumulator;
  /**
   * Async event queue used EXCLUSIVELY by AgentReasoningStep to forward
   * Tool and ToolStatus events that originate inside agent callbacks
   * (which do not have access to the step's writer parameter).
   */
  eventQueue: AsyncEventQueue;
  /** AbortSignal propagated from the HTTP request's abort controller */
  abortSignal: AbortSignal;
  /** Authenticated user resolved from LoopBack auth middleware */
  currentUser: IAuthUserWithPermissions | undefined;
  /** Correlation id propagated across workflow, tools, and model calls */
  correlationId: string;
  /** Workflow identifier for telemetry metadata */
  workflowId: string;
  /** Optional chat session id associated with this workflow invocation */
  chatSessionId: string | undefined;
  /** Resource identifier used for memory isolation */
  resourceId: string;
  /** AI SDK telemetry toggle for request-scoped model calls */
  aiSdkTelemetryEnabled: boolean;
  /** Additional AI SDK telemetry metadata propagated to model calls */
  aiSdkTelemetryMetadata: Record<string, string | number | boolean>;
}

/**
 * Helper: cast an untyped Mastra RequestContext to our fully-typed variant.
 *
 * Usage:
 *   const ctx = asWorkflowContext(requestContext);
 *   const memory = ctx.get('mastraMemory'); // typed as MastraMemory
 */
export function asWorkflowContext(
  requestContext: RequestContext,
): RequestContext<WorkflowRequestContext> {
  return requestContext as RequestContext<WorkflowRequestContext>;
}

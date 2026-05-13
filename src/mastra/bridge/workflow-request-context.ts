import type {RequestContext} from '@mastra/core/request-context';
import type {MastraLanguageModel} from '@mastra/core/agent';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import type {ChatStore} from '../../graphs/chat/chat.store';
import type {AIIntegrationConfig, ToolStore} from '../../types';
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
  /** Chat session store — request-scoped */
  chatStore: ChatStore;
  /** Tool registry for the chat Agent */
  toolStore: ToolStore;
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
}

/**
 * Helper: cast an untyped Mastra RequestContext to our fully-typed variant.
 *
 * Usage:
 *   const ctx = asWorkflowContext(requestContext);
 *   const chatStore = ctx.get('chatStore'); // typed as ChatStore
 */
export function asWorkflowContext(
  requestContext: RequestContext,
): RequestContext<WorkflowRequestContext> {
  return requestContext as RequestContext<WorkflowRequestContext>;
}

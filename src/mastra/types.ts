import {z} from 'zod';
import {LLMStreamEvent} from '../graphs/event.types';
import type {AsyncEventQueue} from './bridge/async-event-queue';
import type {TokenUsageAccumulator} from './bridge/token-usage-accumulator';
import type {ChatStore} from '../graphs/chat/chat.store';
import type {AIIntegrationConfig, JsonObject, MastraToolStore} from '../types';
import type {MastraLanguageModel} from '@mastra/core/agent';

/**
 * Type-safe key map for the RequestContext used by the ChatWorkflow.
 * All request-scoped values are passed through this context.
 */
export type ChatWorkflowRequestContext = {
  /** Abort signal from the HTTP request lifecycle */
  abortSignal: AbortSignal;
  /** Queue for real-time SSE event delivery */
  eventQueue: AsyncEventQueue;
  /** Mastra-compatible LLM for primary chat reasoning */
  mastraChatLlm: MastraLanguageModel;
  /** Mastra-compatible LLM for file summarization */
  mastraFileLlm: MastraLanguageModel;
  /** Per-request chat data store */
  chatStore: ChatStore;
  /** Available Mastra-native tools for the agent */
  mastraTools: MastraToolStore;
  /** AI integration configuration */
  aiConfig: AIIntegrationConfig;
  /** Optional system context additions */
  systemContext: string[] | undefined;
  /** Token usage accumulator for the request */
  tokenUsageAccumulator: TokenUsageAccumulator;
};

/**
 * IMastraTool — Mastra-native tool interface.
 * Implementors provide explicit inputSchema so Mastra tools are fully typed.
 */
export interface IMastraTool {
  /** Tool key (used as tool name by the LLM) */
  key: string;
  /** Human-readable description for the LLM */
  description: string;
  /** Zod schema for the tool's input */
  inputSchema: z.ZodType<JsonObject>;
  /**
   * Execute the tool.
   * @param args - Input data validated against inputSchema
   * @param requestContext - RequestContext for accessing services
   */
  execute(
    args: JsonObject,
    requestContext: {
      get: (key: string) => string | number | boolean | object | undefined;
    },
  ): Promise<JsonObject>;
  /** Extract the human-readable value from the raw result */
  getValue?(result: JsonObject): string;
  /** Extract metadata for DB persistence */
  getMetadata?(result: JsonObject): JsonObject;
  /** Whether this tool requires human review before execution */
  needsReview?: boolean;
}

/**
 * Output produced by the AgentReasoningStep.
 * Contains full conversation context needed for persistence.
 */
export type AgentReasoningOutput = {
  /** Final text response from the agent */
  finalText: string;
  /** All tool calls made during the agent loop */
  toolCalls: ToolCallRecord[];
  /** Total token usage across all agent iterations */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Per-model token breakdown */
  tokenMap: Record<string, {inputTokens: number; outputTokens: number}>;
};

/**
 * A single tool call record with its result.
 */
export type ToolCallRecord = {
  /** LLM-assigned call ID */
  toolCallId: string;
  /** Tool name */
  toolName: string;
  /** Arguments passed to the tool */
  args: JsonObject;
  /** Raw result returned by the tool */
  rawResult: JsonObject;
};

/**
 * Events emitted by the SSE transport. Re-exported for convenience.
 */
export type {LLMStreamEvent};

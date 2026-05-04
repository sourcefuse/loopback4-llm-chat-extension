import {LLMStreamEvent} from '../../../types/events';

/**
 * SSE event writer passed from the Mastra chat agent into the DbQuery workflow.
 * Matches the signature of `config.writer` on LangGraphRunnableConfig.
 */
export type DbQueryWriterFn = (event: LLMStreamEvent) => void;

/**
 * Execution context threaded through every step of the Mastra DbQuery workflow.
 * Passed as `RunnableConfig` to each node so they can emit SSE events and
 * respect request cancellation.
 */
export interface MastraDbQueryContext {
  /**
   * Callback to emit events back to the SSE transport.
   * Accepts `unknown` to allow arbitrary event shapes from step functions
   * (matches `RunnableConfig.writer` semantics).
   */
  writer?: (chunk: unknown) => void;
  /** AbortSignal forwarded from the request lifecycle. Optional. */
  signal?: AbortSignal;
  /**
   * Optional callback invoked by each step after a `generateText()` or
   * `generateObject()` call to report AI SDK token usage.
   *
   * Wire this to `TokenCounter.accumulate()` in the workflow runner so that
   * the Mastra execution path accumulates token counts without LangChain
   * callbacks.
   *
   * @param inputTokens  - Number of prompt tokens consumed.
   * @param outputTokens - Number of completion tokens produced.
   * @param model        - Model identifier string (e.g. `llm.modelId`).
   */
  onUsage?: (inputTokens: number, outputTokens: number, model: string) => void;
}

/**
 * Input accepted by `MastraDbQueryWorkflow.run()`.
 */
export interface DbQueryWorkflowInput {
  /** Natural-language prompt from the user. */
  prompt: string;
  /** Existing dataset UUID when running an improvement flow; omitted for new datasets. */
  datasetId?: string;
  /**
   * When `true`, suppresses ToolStatus events because the caller is rendering
   * results directly (not via the SSE chat transport).
   * Defaults to `false`.
   */
  directCall?: boolean;
}

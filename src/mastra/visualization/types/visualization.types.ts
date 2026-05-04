import {AnyObject} from '@loopback/repository';

// ── Mastra-path state ────────────────────────────────────────────────────────

/**
 * Plain-TypeScript state object for the Mastra Visualization workflow.
 *
 * Mirrors `VisualizationGraphState` (LangGraph) field-for-field but does NOT
 * depend on `@langchain/langgraph` `Annotation` — making every step function
 * completely LangGraph-free.
 *
 * `visualizer` references `IMastraVisualizer` (the Mastra-path visualizer
 * interface) rather than the LangGraph-coupled `IVisualizer`.
 */
export interface MastraVisualizationState {
  /** Natural-language prompt from the user. */
  prompt: string;
  /**
   * Existing dataset UUID (when provided up-front or set by the
   * `callQueryGeneration` step after creating a new dataset).
   */
  datasetId?: string;
  /** SQL query string fetched from the dataset store. */
  sql?: string;
  /** Human-readable description of the dataset's SQL query. */
  queryDescription?: string;
  /**
   * The resolved `IMastraVisualizer` instance that will render the chart.
   * Set by `selectVisualizationStep`.
   */
  visualizer?: IMastraVisualizer;
  /** Friendly name of the chosen visualizer (e.g. `'bar'`). */
  visualizerName?: string;
  /** `true` once the visualization has been successfully rendered. */
  done?: boolean;
  /** Final chart configuration object emitted to the SSE transport. */
  visualizerConfig?: AnyObject;
  /**
   * Non-empty string means the workflow entered an error path.
   * The `renderVisualization` step is skipped when `error` is set.
   */
  error?: string;
  /**
   * Optional visualization type hint supplied by the caller.
   * When present, `selectVisualizationStep` bypasses the LLM selection call.
   */
  type?: string;
}

// ── Mastra-path visualizer interface ────────────────────────────────────────

/**
 * Interface for a Mastra-path visualizer.
 *
 * Mirrors `IVisualizer` (LangGraph component) but:
 *  - accepts `MastraVisualizationState` instead of `VisualizationGraphState`
 *  - uses AI SDK `generateObject()` internally (no `withStructuredOutput()`)
 *
 * Each chart-type service (`MastraBarVisualizerService`, etc.) implements this.
 */
export interface IMastraVisualizer {
  /** Unique chart type identifier (e.g. `'bar'`, `'line'`, `'pie'`). */
  name: string;
  /** Short description shown to the LLM for visualizer selection. */
  description: string;
  /**
   * Optional guidance injected into the data-generation prompt so the SQL
   * query returns columns shaped for this chart type.
   */
  context?: string;
  /**
   * Generate and return a chart configuration object for the given state.
   * Implementations use AI SDK `generateObject()` with a Zod schema.
   * @param onUsage Optional callback to report token usage for rate limiting.
   */
  getConfig(
    state: MastraVisualizationState,
    onUsage?: (
      inputTokens: number,
      outputTokens: number,
      model: string,
    ) => void,
  ): Promise<AnyObject>;
}

// ── Execution context ────────────────────────────────────────────────────────

/**
 * Execution context threaded through every step of the Mastra Visualization
 * workflow. Mirrors `MastraDbQueryContext` — passed as the second argument to
 * every step function so they can emit SSE events and respect cancellation.
 */
export interface MastraVisualizationContext {
  /**
   * Callback to emit streaming events back to the SSE transport.
   * Accepts `unknown` to allow arbitrary event shapes from step functions
   * (matches `RunnableConfig.writer` semantics used by the LangGraph path).
   */
  writer?: (chunk: unknown) => void;
  /** AbortSignal forwarded from the request lifecycle. Optional. */
  signal?: AbortSignal;
  /**
   * Optional callback invoked after `generateText()` / `generateObject()` to
   * report AI SDK token usage for the Mastra path's token counting.
   *
   * Wire to `TokenCounter.accumulate()` in the workflow runner.
   *
   * @param inputTokens  - Prompt tokens consumed.
   * @param outputTokens - Completion tokens produced.
   * @param model        - Model identifier string.
   */
  onUsage?: (inputTokens: number, outputTokens: number, model: string) => void;
}

// ── Workflow input ───────────────────────────────────────────────────────────

/**
 * Input accepted by `MastraVisualizationWorkflow.run()`.
 *
 * Mirrors the Zod schema declared on `GenerateVisualizationTool.inputSchema`.
 */
export interface VisualizationWorkflowInput {
  /** Natural-language prompt describing the visualization the user wants. */
  prompt: string;
  /**
   * Optional existing dataset UUID. When provided, the workflow skips the
   * `callQueryGeneration` step and uses this dataset directly.
   */
  datasetId?: string;
  /**
   * Optional visualization type hint (e.g. `'bar'`, `'line'`, `'pie'`).
   * When provided, the `selectVisualization` step skips the LLM selection
   * call and uses the named visualizer directly.
   */
  type?: string;
}

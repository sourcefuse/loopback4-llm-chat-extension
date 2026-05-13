import {TokenMetadata} from '../../types';

/**
 * TokenUsageAccumulator — per-request token usage tracker for Mastra workflows.
 *
 * Replaces the LangChain callback-based `TokenCounter`. In the Mastra architecture,
 * token usage is captured from the `step-finish` events emitted by `agent.stream()`.
 *
 * Lifecycle: Created per HTTP request by WorkflowRunner, stored in RequestContext,
 * read by EndSessionStep to persist final counts.
 */
export class TokenUsageAccumulator {
  private _inputs = 0;
  private _outputs = 0;
  private readonly _countMap = new Map<
    string,
    {inputTokens: number; outputTokens: number}
  >();

  /**
   * Accumulate token usage for a given model.
   *
   * @param modelName - LLM model identifier (e.g. "gpt-4o", "claude-3-5-sonnet")
   * @param inputTokens - Prompt / input token count
   * @param outputTokens - Completion / output token count
   */
  accumulate(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
  ): void {
    this._inputs += inputTokens;
    this._outputs += outputTokens;

    const prev = this._countMap.get(modelName) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    this._countMap.set(modelName, {
      inputTokens: prev.inputTokens + inputTokens,
      outputTokens: prev.outputTokens + outputTokens,
    });
  }

  /**
   * Get the accumulated counts.
   */
  getCounts(): {
    inputs: number;
    outputs: number;
    map: TokenMetadata;
  } {
    return {
      inputs: this._inputs,
      outputs: this._outputs,
      map: Object.fromEntries(this._countMap.entries()),
    };
  }

  /**
   * Reset all counters (used in tests).
   */
  clear(): void {
    this._inputs = 0;
    this._outputs = 0;
    this._countMap.clear();
  }
}

import {BindingScope, injectable} from '@loopback/core';

const debug = require('debug')('ai-integration:mastra:token-counter');

@injectable({scope: BindingScope.REQUEST})
export class TokenCounter {
  private inputs = 0;
  private outputs = 0;
  private countMap: Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
    }
  > = new Map();

  clear() {
    this.inputs = 0;
    this.outputs = 0;
    this.countMap.clear();
  }

  // ── Mastra path (AI SDK usage field) ────────────────────────────────────

  /**
   * Accumulate token counts directly from an AI SDK `usage` object.
   *
   * Called by Mastra step functions after every `generateText()` /
   * `generateObject()` call — no LangChain callback required.
   *
   * @param inputTokens  - `usage.promptTokens` from the AI SDK response.
   * @param outputTokens - `usage.completionTokens` from the AI SDK response.
   * @param model        - Model identifier (e.g. `deps.llm.modelId`).
   */
  accumulate(inputTokens: number, outputTokens: number, model: string): void {
    const prev = this.countMap.get(model) ?? {inputTokens: 0, outputTokens: 0};
    this.inputs += inputTokens;
    this.outputs += outputTokens;
    prev.inputTokens += inputTokens;
    prev.outputTokens += outputTokens;
    this.countMap.set(model, prev);
    debug('token usage captured', {inputTokens, outputTokens, model});
  }

  getCounts() {
    return {
      inputs: this.inputs,
      outputs: this.outputs,
      map: Object.fromEntries(this.countMap.entries()),
    };
  }
}

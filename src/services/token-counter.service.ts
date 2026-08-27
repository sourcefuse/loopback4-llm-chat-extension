import {BindingScope, injectable} from '@loopback/core';
import {LLMEndResult} from '../graphs/types';

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
  private runMap: Map<string, string> = new Map();

  clear() {
    this.inputs = 0;
    this.outputs = 0;
    this.countMap.clear();
    this.runMap.clear();
  }

  handleLlmStart(runId: string, modelName: string): void {
    this.runMap.set(runId, modelName);
  }

  handleLlmEnd(runId: string, message: LLMEndResult) {
    const llmName = this.runMap.get(runId) ?? 'unknown';
    this.runMap.delete(runId);
    const usageMetadata = message.generations[0][0].message.usage_metadata;
    const prev = this.countMap.get(llmName) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    if (usageMetadata) {
      this.inputs += usageMetadata.input_tokens ?? 0;
      this.outputs += usageMetadata.output_tokens ?? 0;
      prev.inputTokens += usageMetadata.input_tokens ?? 0;
      prev.outputTokens += usageMetadata.output_tokens ?? 0;
      this.countMap.set(llmName, prev);
    }
    return {
      inputTokens: this.inputs,
      outputTokens: this.outputs,
    };
  }
  getCounts() {
    return {
      inputs: this.inputs,
      outputs: this.outputs,
      map: Object.fromEntries(this.countMap.entries()),
    };
  }
}

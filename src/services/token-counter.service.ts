import {AIMessage} from '@langchain/core/messages';
import {LLMResult} from '@langchain/core/outputs';
import {BindingScope, injectable} from '@loopback/core';

@injectable({scope: BindingScope.REQUEST})
export class TokenCounter {
  private inputs = 0;
  private outputs = 0;

  handleLlmEnd(message: LLMResult) {
    const usageMetadata = (
      message.generations[0][0] as unknown as {message: AIMessage}
    ).message.usage_metadata;
    if (usageMetadata) {
      this.inputs += usageMetadata.input_tokens;
      this.outputs += usageMetadata.output_tokens;
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
    };
  }
}

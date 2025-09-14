import {ChatCerebras, ChatCerebrasInput} from '@langchain/cerebras';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Cerebras implements Provider<LLMProvider> {
  value() {
    if (!process.env.CEREBRAS_MODEL || !process.env.CEREBRAS_KEY) {
      throw new Error(
        'CEREBRAS_MODEL and CEREBRAS_KEY environment variable is not set.',
      );
    }
    const config: ChatCerebrasInput = {
      temperature: parseFloat(process.env.CEREBRAS_TEMPERATURE ?? '0'),
      model: process.env.CEREBRAS_MODEL,
      apiKey: process.env.CEREBRAS_KEY, // Default value.
    };
    if (process.env.CEREBRAS_TOP_P) {
      config.topP = parseFloat(process.env.CEREBRAS_TOP_P);
    }
    if (process.env.CEREBRAS_MAX_TOKENS) {
      config.maxCompletionTokens = parseInt(process.env.CEREBRAS_MAX_TOKENS);
    }
    return new ChatCerebras(config);
  }
}

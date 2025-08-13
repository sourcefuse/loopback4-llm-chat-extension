import {ChatCerebras} from '@langchain/cerebras';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Cerebras implements Provider<LLMProvider> {
  value() {
    if (!process.env.CEREBRAS_MODEL || !process.env.CEREBRAS_KEY) {
      throw new Error(
        'CEREBRAS_MODEL and CEREBRAS_KEY environment variable is not set.',
      );
    }
    return new ChatCerebras({
      model: process.env.CEREBRAS_MODEL,
      apiKey: process.env.CEREBRAS_KEY, // Default value.
    });
  }
}

import {createCerebras} from '@ai-sdk/cerebras';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export class Cerebras implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.CEREBRAS_MODEL || !process.env.CEREBRAS_KEY) {
      throw new Error(
        'CEREBRAS_MODEL and CEREBRAS_KEY environment variable is not set.',
      );
    }
    const provider = createCerebras({apiKey: process.env.CEREBRAS_KEY});
    return provider(process.env.CEREBRAS_MODEL);
  }
}

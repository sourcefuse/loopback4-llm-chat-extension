import {Provider} from '@loopback/core';
import {createGroq} from '@ai-sdk/groq';
import {LLMProvider} from '../../../../types';

export class Groq implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.GROQ_MODEL || !process.env.GROQ_API_KEY) {
      throw new Error(
        'GROQ_MODEL and GROQ_API_KEY environment variable is not set.',
      );
    }
    const provider = createGroq({apiKey: process.env.GROQ_API_KEY});
    return provider(process.env.GROQ_MODEL);
  }
}

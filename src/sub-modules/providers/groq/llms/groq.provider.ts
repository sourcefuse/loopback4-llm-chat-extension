import {Provider} from '@loopback/core';
import {ChatGroq} from '@langchain/groq';
import {LLMProvider} from '../../../../types';

export class Groq implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.GROQ_MODEL || !process.env.GROQ_API_KEY) {
      throw new Error(
        'GROQ_MODEL and GROQ_API_KEY environment variable is not set.',
      );
    }
    return new ChatGroq({
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      maxTokens: undefined,
    });
  }
}

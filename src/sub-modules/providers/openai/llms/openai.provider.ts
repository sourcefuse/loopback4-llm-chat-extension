import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {createOpenAI} from '@ai-sdk/openai';

export class OpenAI implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.OPENAI_MODEL || !process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_MODEL and OPENAI_API_KEY environment variables must be set.',
      );
    }
    const provider = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_API_BASE_URL,
    });
    return provider(process.env.OPENAI_MODEL);
  }
}

import {Provider} from '@loopback/core';
import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {LLMProvider} from '../../../../types';

export class OpenRouter implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.OPENROUTER_MODEL || !process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_MODEL and OPENROUTER_API_KEY environment variables must be set.',
      );
    }
    const provider = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: process.env.OPENROUTER_BASE_URL,
    });
    return provider(process.env.OPENROUTER_MODEL);
  }
}

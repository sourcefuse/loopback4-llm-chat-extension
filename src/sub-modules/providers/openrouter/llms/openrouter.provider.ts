import {Provider} from '@loopback/core';
import {ChatOpenRouter} from '@langchain/openrouter';
import {LLMProvider} from '../../../../types';
import {OpenRouterInstanceConfig} from '../types';

export class OpenRouter implements Provider<LLMProvider> {
  static createInstance(config: OpenRouterInstanceConfig): ChatOpenRouter {
    return new ChatOpenRouter({
      model: config.model,
      ...config.config,
    });
  }
  value(): LLMProvider {
    if (!process.env.OPENROUTER_MODEL || !process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_MODEL and OPENROUTER_API_KEY environment variables must be set.',
      );
    }
    return OpenRouter.createInstance({
      model: process.env.OPENROUTER_MODEL,
      config: {
        apiKey: process.env.OPENROUTER_API_KEY,
        temperature: Number.parseFloat(
          process.env.OPENROUTER_TEMPERATURE ?? '0',
        ),
        baseURL: process.env.OPENROUTER_BASE_URL,
      },
    });
  }
}

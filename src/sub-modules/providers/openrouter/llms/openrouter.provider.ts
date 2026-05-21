import {Provider} from '@loopback/core';
import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {LLMProvider} from '../../../../types';
import {OpenRouterInstanceConfig} from '../types';

export class OpenRouter implements Provider<LLMProvider> {
  static createInstance(config: OpenRouterInstanceConfig): LLMProvider {
    const provider = createOpenRouter(config.providerSettings);
    return provider(config.model, config.settings) as unknown as LLMProvider;
  }

  value(): LLMProvider {
    if (!process.env.OPENROUTER_MODEL || !process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_MODEL and OPENROUTER_API_KEY environment variables must be set.',
      );
    }

    const temperature = process.env.OPENROUTER_TEMPERATURE;

    return OpenRouter.createInstance({
      model: process.env.OPENROUTER_MODEL,
      providerSettings: {
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: process.env.OPENROUTER_BASE_URL,
      },
      settings: temperature
        ? {
            temperature: Number.parseFloat(temperature),
          }
        : undefined,
    });
  }
}

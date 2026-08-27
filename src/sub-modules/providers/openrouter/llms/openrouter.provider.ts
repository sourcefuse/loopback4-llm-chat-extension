import {Provider} from '@loopback/core';
import {
  createOpenRouter,
  type OpenRouterChatSettings,
} from '@openrouter/ai-sdk-provider';
import {LLMProvider} from '../../../../types';
import {OpenRouterInstanceConfig} from '../types';

export class OpenRouter implements Provider<LLMProvider> {
  static createInstance(config: OpenRouterInstanceConfig): LLMProvider {
    const provider = createOpenRouter({
      apiKey: config.config.apiKey,
      baseURL: config.config.baseURL,
    });

    const settings: OpenRouterChatSettings = {};
    if (config.config.provider) {
      settings.provider = config.config.provider;
    }
    if (config.config.reasoningEffort) {
      // `effort` is OpenRouter's native reasoning control; `summary` is an
      // OpenAI-only field OpenRouter ignores, forwarded here for parity.
      settings.reasoning = {
        effort: config.config.reasoningEffort,
        ...(config.config.reasoningSummary
          ? {summary: config.config.reasoningSummary}
          : {}),
      } as OpenRouterChatSettings['reasoning'];
    }

    const model = provider.chat(
      config.model,
      settings,
    ) as unknown as LLMProvider;
    if (config.config.temperature !== undefined) {
      model.defaultSettings = {
        temperature: config.config.temperature,
      };
    }
    return model;
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

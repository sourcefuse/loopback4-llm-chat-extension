import {Provider} from '@loopback/core';
import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {LLMProvider} from '../../../../types';
import {CreateOpenRouterModelOptions, OpenRouterInstanceConfig} from '../types';

export class OpenRouter implements Provider<LLMProvider> {
  static createInstance({
    model,
    config,
  }: OpenRouterInstanceConfig): LLMProvider {
    if (!config.apiKey) {
      throw new Error('apiKey is required for OpenRouter.createInstance');
    }
    const provider = createOpenRouter({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    return provider(model, {
      temperature: config.temperature,
      provider: config.provider,
      reasoning: config.reasoning?.effort
        ? {effort: config.reasoning.effort}
        : undefined,
      extraBody: config.reasoning?.effort
        ? {reasoning: {summary: config.reasoning.summary}}
        : undefined,
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
        baseURL: process.env.OPENROUTER_BASE_URL,
      },
    });
  }
}

/**
 * Convenience factory that reads `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL`
 * from env and accepts string temperature (suitable for direct env-var wiring).
 * Delegates to {@link OpenRouter.createInstance}.
 */
export function createOpenRouterModel(
  model: string | undefined,
  options: CreateOpenRouterModelOptions = {},
): LLMProvider {
  if (!model) {
    throw new Error('Model must be specified for createOpenRouterModel');
  }
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY environment variable must be set for createOpenRouterModel',
    );
  }
  return OpenRouter.createInstance({
    model,
    config: {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: process.env.OPENROUTER_BASE_URL,
      temperature: options.temperature
        ? Number.parseFloat(options.temperature)
        : undefined,
      provider: options.provider,
      reasoning: options.reasoningEffort
        ? {effort: options.reasoningEffort, summary: options.reasoningSummary}
        : undefined,
    },
  });
}

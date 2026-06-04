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

/**
 * Factory variant of {@link OpenRouter} — builds a model for a specific
 * model id (e.g. `'openai/gpt-4o-mini'`). Consumers use this when binding
 * tier slots (CheapLLM / SmartLLM / SmartNonThinkingLLM) to per-tier
 * models without depending on `@openrouter/ai-sdk-provider` directly.
 *
 * Reads `OPENROUTER_API_KEY` (required) and `OPENROUTER_BASE_URL`
 * (optional) from env. The model id is the only per-tier knob.
 */
export function createOpenRouterModel(model: string): LLMProvider {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY env var required for createOpenRouterModel',
    );
  }
  const provider = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL,
  });
  return provider(model);
}

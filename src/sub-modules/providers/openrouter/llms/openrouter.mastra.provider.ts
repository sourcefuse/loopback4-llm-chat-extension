import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped OpenRouter provider. Bind to MastraChatLLM.
 * Replaces the legacy `OpenRouter` provider that depended on the
 * unpublished `@langchain/openrouter` package.
 */
export class MastraOpenRouter implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.OPENROUTER_MODEL || !process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_MODEL and OPENROUTER_API_KEY env vars required for MastraOpenRouter',
      );
    }
    return createMastraOpenRouterModel(process.env.OPENROUTER_MODEL);
  }
}

/**
 * Factory variant of MastraOpenRouter — builds a MastraModelConfig for a
 * specific model id (e.g. `'openai/gpt-4o-mini'`). Consumers use this when
 * binding tier slots (MastraCheapLLM / MastraSmartLLM /
 * MastraSmartNonThinkingLLM) to per-tier models without having to depend
 * on `@openrouter/ai-sdk-provider` directly.
 *
 * Reads `OPENROUTER_API_KEY` (required) and `OPENROUTER_BASE_URL`
 * (optional) from env. The model id is the only per-tier knob.
 */
export function createMastraOpenRouterModel(model: string): MastraModelConfig {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY env var required for createMastraOpenRouterModel',
    );
  }
  const provider = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: process.env.OPENROUTER_BASE_URL,
  });
  return provider(model);
}

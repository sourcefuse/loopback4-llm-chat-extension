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
    const provider = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: process.env.OPENROUTER_BASE_URL,
    });
    return provider(process.env.OPENROUTER_MODEL);
  }
}

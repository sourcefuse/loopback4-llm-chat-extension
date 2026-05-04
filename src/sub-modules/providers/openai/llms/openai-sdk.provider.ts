import {createOpenAI} from '@ai-sdk/openai';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

export type OpenAISdkInstanceConfig = {
  model: string;
  config?: {
    apiKey?: string;
    baseURL?: string;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
    reasoningSummary?: 'auto' | 'concise' | 'detailed';
    /** OpenRouter / custom provider overrides */
    configuration?: {
      baseURL?: string;
      [key: string]: unknown;
    };
    reasoning?: {
      effort?: string | null;
      summary?: string | null;
    };
    modelKwargs?: Record<string, unknown>;
  };
};

/**
 * AI SDK (Vercel) provider for OpenAI models.
 *
 * Returns a `LanguageModel` compatible with `generateText()` / `generateObject()`
 * from the `ai` package.  Bind to `AiIntegrationBindings.AiSdkSmartLLM` (or the
 * other `AiSdk*` keys) for use in the Mastra db-query workflow nodes.
 */
export class OpenAISdk implements Provider<LLMProvider> {
  static createInstance(config: OpenAISdkInstanceConfig): LLMProvider {
    const openai = createOpenAI({
      apiKey: config.config?.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.config?.baseURL ?? config.config?.configuration?.baseURL,
    });
    // temperature / reasoningEffort are passed per-call in generateText() — not at model creation
    return openai(config.model);
  }

  value(): LLMProvider {
    if (!process.env.OPENAI_MODEL) {
      throw new Error('OPENAI_MODEL environment variable is not set');
    }
    return OpenAISdk.createInstance({
      model: process.env.OPENAI_MODEL,
      config: {
        temperature: process.env.OPENAI_TEMPERATURE
          ? Number.parseFloat(process.env.OPENAI_TEMPERATURE)
          : undefined,
        baseURL: process.env.OPENAI_API_BASE_URL,
      },
    });
  }
}

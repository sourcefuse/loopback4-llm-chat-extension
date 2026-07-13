import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';
import {createOpenAI} from '@ai-sdk/openai';

export class OpenAI implements Provider<LLMProvider> {
  /**
   * Back-compat factory preserved from the LangGraph extension's
   * `OpenAI.createInstance`. Builds an AI-SDK `LanguageModel` for a specific
   * model id; delegates to {@link createOpenAIModel}. The signature is
   * AI-SDK-shaped `(model, opts)` rather than the old LangChain
   * `OpenAIInstanceConfig` (which wrapped `@langchain/openai` fields that no
   * longer exist), but the symbol is retained so host references resolve.
   */
  static createInstance(
    model: string,
    opts: {apiKey?: string; baseURL?: string} = {},
  ): LLMProvider {
    return createOpenAIModel(model, opts);
  }

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

/**
 * Factory variant of {@link OpenAI} — builds a model for a specific OpenAI
 * model id (e.g. `'gpt-4o'`, `'gpt-4o-mini'`). Consumers use this when
 * binding tier slots (CheapLLM / SmartLLM / SmartNonThinkingLLM) to
 * per-tier OpenAI models without depending on `@ai-sdk/openai` directly.
 *
 * `opts.apiKey` defaults to `OPENAI_API_KEY`, `opts.baseURL` to
 * `OPENAI_API_BASE_URL`. Pass `apiKey` explicitly when the consumer has a
 * separate "Mastra-only" OpenAI key that should NOT override the legacy
 * `OPENAI_API_KEY` slot (which may be re-pointed at an OpenAI-compatible
 * gateway like OpenRouter).
 */
export function createOpenAIModel(
  model: string,
  opts: {apiKey?: string; baseURL?: string} = {},
): LLMProvider {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY (or opts.apiKey) required for createOpenAIModel',
    );
  }
  const provider = createOpenAI({
    apiKey,
    baseURL: opts.baseURL ?? process.env.OPENAI_API_BASE_URL,
  });
  return provider(model);
}

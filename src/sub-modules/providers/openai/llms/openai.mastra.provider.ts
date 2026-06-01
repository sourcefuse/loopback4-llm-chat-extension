import {createOpenAI} from '@ai-sdk/openai';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped OpenAI provider. Bind to `MastraChatLLM`,
 * `MastraFileLLM`, etc. Keeps the legacy LangChain `OpenAI` provider
 * intact for ChatGraph / DbQuery callsites until P3.
 */
export class MastraOpenAI implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.OPENAI_MODEL || !process.env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_MODEL and OPENAI_API_KEY env vars required for MastraOpenAI',
      );
    }
    return createMastraOpenAIModel(process.env.OPENAI_MODEL);
  }
}

/**
 * Factory variant of MastraOpenAI — builds a MastraModelConfig for a
 * specific OpenAI model id (e.g. `'gpt-4o'`, `'gpt-4o-mini'`). Consumers
 * use this when binding tier slots (MastraCheapLLM / MastraSmartLLM /
 * MastraSmartNonThinkingLLM) to per-tier OpenAI models without depending
 * on `@ai-sdk/openai` directly.
 *
 * `opts.apiKey` defaults to `OPENAI_API_KEY`, `opts.baseURL` to
 * `OPENAI_API_BASE_URL`. Pass `apiKey` explicitly when the consumer has
 * a separate "Mastra-only" OpenAI key that should NOT override the
 * legacy `OPENAI_API_KEY` slot (which may be re-pointed at an
 * OpenAI-compatible gateway like OpenRouter).
 */
export function createMastraOpenAIModel(
  model: string,
  opts: {apiKey?: string; baseURL?: string} = {},
): MastraModelConfig {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY (or opts.apiKey) required for createMastraOpenAIModel',
    );
  }
  const provider = createOpenAI({
    apiKey,
    baseURL: opts.baseURL ?? process.env.OPENAI_API_BASE_URL,
  });
  return provider(model);
}

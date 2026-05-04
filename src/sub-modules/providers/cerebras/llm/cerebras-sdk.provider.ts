import {createCerebras} from '@ai-sdk/cerebras';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

/**
 * AI SDK (Vercel) provider for Cerebras models.
 *
 * Returns a `LanguageModel` compatible with `generateText()` / `generateObject()`
 * from the `ai` package.  Bind to `AiIntegrationBindings.AiSdkCheapLLM` (or the
 * other `AiSdk*` keys) for use in the Mastra db-query workflow nodes.
 *
 * Environment variables:
 *   - `CEREBRAS_MODEL`      — model id, e.g. `llama-4-scout-17b-16e-instruct`
 *   - `CEREBRAS_KEY`        — Cerebras API key
 *   - `CEREBRAS_TEMPERATURE` — optional temperature (default 0)
 *   - `CEREBRAS_MAX_TOKENS`  — optional max tokens
 */
export class CerebrasSdk implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.CEREBRAS_MODEL || !process.env.CEREBRAS_KEY) {
      throw new Error(
        'CEREBRAS_MODEL and CEREBRAS_KEY environment variables must be set',
      );
    }
    const cerebras = createCerebras({
      apiKey: process.env.CEREBRAS_KEY,
    });
    // temperature / maxTokens are passed per-call in generateText()
    return cerebras(process.env.CEREBRAS_MODEL);
  }
}

import {createGroq} from '@ai-sdk/groq';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

/**
 * AI SDK (Vercel) provider for Groq models.
 *
 * Returns a `LanguageModel` compatible with `generateText()` / `generateObject()`
 * from the `ai` package.  Bind to `AiIntegrationBindings.AiSdkCheapLLM` (or the
 * other `AiSdk*` keys) for use in the Mastra db-query workflow nodes.
 *
 * Environment variables:
 *   - `GROQ_MODEL`       — model id, e.g. `llama-3.3-70b-versatile`
 *   - `GROQ_API_KEY`     — Groq API key
 *   - `GROQ_TEMPERATURE` — optional temperature (default 0)
 */
export class GroqSdk implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.GROQ_MODEL || !process.env.GROQ_API_KEY) {
      throw new Error(
        'GROQ_MODEL and GROQ_API_KEY environment variables must be set',
      );
    }
    const groq = createGroq({
      apiKey: process.env.GROQ_API_KEY,
    });
    // temperature is passed per-call in generateText()
    return groq(process.env.GROQ_MODEL);
  }
}

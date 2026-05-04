import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {Provider} from '@loopback/core';
import {LLMProvider} from '../../../../types';

/**
 * AI SDK (Vercel) provider for Google Gemini models.
 *
 * Returns a `LanguageModel` compatible with `generateText()` / `generateObject()`
 * from the `ai` package.  Bind to `AiIntegrationBindings.AiSdkSmartLLM` (or the
 * other `AiSdk*` keys) for use in the Mastra db-query workflow nodes.
 *
 * Environment variables:
 *   - `GOOGLE_CHAT_MODEL`   — model id, e.g. `gemini-2.0-flash`
 *   - `GOOGLE_API_KEY`      — Google Generative AI API key
 */
export class GeminiSdk implements Provider<LLMProvider> {
  value(): LLMProvider {
    if (!process.env.GOOGLE_CHAT_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'GOOGLE_CHAT_MODEL and GOOGLE_API_KEY environment variables must be set',
      );
    }
    const google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });
    return google(process.env.GOOGLE_CHAT_MODEL);
  }
}

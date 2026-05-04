import {createOllama} from 'ollama-ai-provider';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';

/**
 * AI SDK (Vercel) provider for Ollama models.
 *
 * Returns a `LanguageModel` compatible with `generateText()` / `generateObject()`
 * from the `ai` package.  Bind to `AiIntegrationBindings.AiSdkSmartLLM` (or the
 * other `AiSdk*` keys) for use in the Mastra db-query workflow nodes.
 *
 * Environment variables:
 *   - `OLLAMA_MODEL`    — model id, e.g. `llama3.2`
 *   - `OLLAMA_BASE_URL` — Ollama server URL, e.g. `http://localhost:11434`
 */
export class OllamaSdk implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    if (!process.env.OLLAMA_MODEL || !process.env.OLLAMA_BASE_URL) {
      throw new Error(
        'OLLAMA_MODEL and OLLAMA_BASE_URL environment variables must be set',
      );
    }
    const ollama = createOllama({
      baseURL: `${process.env.OLLAMA_BASE_URL}/api`,
    });
    // ollama-ai-provider returns LanguageModelV1; cast is safe — it satisfies the
    // LanguageModel contract at runtime even though types diverge in ai v6.
    return ollama(process.env.OLLAMA_MODEL) as unknown as LLMProvider;
  }
}

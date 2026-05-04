import {createAnthropic} from '@ai-sdk/anthropic';
import {Provider, ValueOrPromise} from '@loopback/core';
import {LLMProvider} from '../../../../types';

/**
 * AI SDK (Vercel) provider for Anthropic Claude models.
 *
 * Returns a `LanguageModel` compatible with `generateText()` / `generateObject()`
 * from the `ai` package.  Bind to `AiIntegrationBindings.AiSdkSmartLLM` (or the
 * other `AiSdk*` keys) for use in the Mastra db-query workflow nodes.
 *
 * Environment variables:
 *   - `CLAUDE_MODEL`            — model id, e.g. `claude-3-5-sonnet-20241022`
 *   - `CLAUDE_API_KEY`          — Anthropic API key
 *   - `CLAUDE_THINKING`         — set to `'true'` to enable extended thinking
 *   - `CLAUDE_THINKING_BUDGET`  — token budget for extended thinking (default 1024)
 *   - `CLAUDE_TEMPERATURE`      — optional temperature override (0–1)
 */
export class ClaudeSdk implements Provider<LLMProvider> {
  value(): ValueOrPromise<LLMProvider> {
    if (!process.env.CLAUDE_MODEL || !process.env.CLAUDE_API_KEY) {
      throw new Error(
        'CLAUDE_MODEL and CLAUDE_API_KEY environment variables must be set',
      );
    }
    const anthropic = createAnthropic({
      apiKey: process.env.CLAUDE_API_KEY,
    });
    // thinking / temperature are passed per-call via providerOptions in generateText()
    return anthropic(process.env.CLAUDE_MODEL);
  }
}

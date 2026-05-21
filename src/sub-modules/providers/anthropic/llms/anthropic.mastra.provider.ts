import {createAnthropic} from '@ai-sdk/anthropic';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped Anthropic Claude provider. Bind to MastraChatLLM
 * for the v3 path. Thinking / temperature still configured via env vars but
 * applied through AI SDK `providerOptions` at call time, not at model
 * construction.
 */
export class MastraClaude implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.CLAUDE_MODEL || !process.env.CLAUDE_API_KEY) {
      throw new Error(
        'CLAUDE_MODEL and CLAUDE_API_KEY env vars required for MastraClaude',
      );
    }
    const provider = createAnthropic({apiKey: process.env.CLAUDE_API_KEY});
    return provider(process.env.CLAUDE_MODEL);
  }
}

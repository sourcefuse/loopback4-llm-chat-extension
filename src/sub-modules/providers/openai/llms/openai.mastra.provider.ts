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
    const provider = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_API_BASE_URL,
    });
    return provider(process.env.OPENAI_MODEL);
  }
}

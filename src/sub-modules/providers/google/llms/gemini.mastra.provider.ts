import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped Google Gemini provider. Bind to MastraChatLLM.
 */
export class MastraGemini implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.GOOGLE_CHAT_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'GOOGLE_CHAT_MODEL and GOOGLE_API_KEY env vars required for MastraGemini',
      );
    }
    const provider = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });
    return provider(process.env.GOOGLE_CHAT_MODEL);
  }
}

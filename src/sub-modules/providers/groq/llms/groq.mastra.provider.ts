import {createGroq} from '@ai-sdk/groq';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped Groq provider. Bind to MastraChatLLM.
 */
export class MastraGroq implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.GROQ_MODEL || !process.env.GROQ_API_KEY) {
      throw new Error(
        'GROQ_MODEL and GROQ_API_KEY env vars required for MastraGroq',
      );
    }
    const provider = createGroq({apiKey: process.env.GROQ_API_KEY});
    return provider(process.env.GROQ_MODEL);
  }
}

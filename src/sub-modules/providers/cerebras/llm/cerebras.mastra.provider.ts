import {createCerebras} from '@ai-sdk/cerebras';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped Cerebras provider. Bind to MastraChatLLM.
 */
export class MastraCerebras implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.CEREBRAS_MODEL || !process.env.CEREBRAS_KEY) {
      throw new Error(
        'CEREBRAS_MODEL and CEREBRAS_KEY env vars required for MastraCerebras',
      );
    }
    const provider = createCerebras({apiKey: process.env.CEREBRAS_KEY});
    return provider(process.env.CEREBRAS_MODEL);
  }
}

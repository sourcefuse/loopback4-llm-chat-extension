import {createOllama} from 'ollama-ai-provider';
import {Provider} from '@loopback/core';
import type {MastraModelConfig} from '@mastra/core/llm';

/**
 * AI SDK / Mastra-shaped Ollama provider (community AI SDK package).
 * Bind to MastraChatLLM.
 */
export class MastraOllama implements Provider<MastraModelConfig> {
  value(): MastraModelConfig {
    if (!process.env.OLLAMA_MODEL || !process.env.OLLAMA_BASE_URL) {
      throw new Error(
        'OLLAMA_MODEL and OLLAMA_BASE_URL env vars required for MastraOllama',
      );
    }
    const provider = createOllama({baseURL: process.env.OLLAMA_BASE_URL});
    return provider(process.env.OLLAMA_MODEL);
  }
}

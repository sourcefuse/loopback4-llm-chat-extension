import {createOpenAI} from '@ai-sdk/openai';
import {Provider, ValueOrPromise} from '@loopback/core';
import {EmbeddingModel} from 'ai';

/**
 * AI SDK embedding provider for Ollama.
 *
 * Uses @ai-sdk/openai pointed at Ollama's OpenAI-compatible endpoint
 * because `ollama-ai-provider` only implements spec v1,
 * which is unsupported by AI SDK 6.
 *
 * Environment variables:
 *   - `OLLAMA_EMBEDDING_MODEL` — e.g. `nomic-embed-text`
 *   - `OLLAMA_BASE_URL` — default `http://localhost:11434/api`
 */
export class OllamaEmbeddingSdk implements Provider<EmbeddingModel> {
  value(): ValueOrPromise<EmbeddingModel> {
    const model = process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text';
    const baseURL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    // Ollama exposes an OpenAI-compatible API at /v1
    const openai = createOpenAI({
      baseURL: `${baseURL.replace(/\/api$/, '')}/v1`,
      apiKey: 'ollama', // Ollama doesn't require a real key
    });
    return openai.embedding(model) as unknown as EmbeddingModel;
  }
}

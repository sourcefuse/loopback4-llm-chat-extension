import {createOpenAI} from '@ai-sdk/openai';
import {Provider} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

// Ollama exposes OpenAI-compatible embeddings at `<base>/v1/embeddings`. Driven
// through `@ai-sdk/openai` (spec v2/v3) instead of `ollama-ai-provider`, whose
// spec-v1 embedding model Mastra's AI-SDK v6 runtime rejects. Set
// OLLAMA_EMBEDDING_MODEL to a pulled embed model (e.g. `nomic-embed-text`).
export class OllamaEmbedding implements Provider<EmbeddingProvider> {
  value(): EmbeddingProvider {
    if (!process.env.OLLAMA_EMBEDDING_MODEL) {
      throw new Error('OLLAMA_EMBEDDING_MODEL environment variable is not set');
    }
    const base = (
      process.env.OLLAMA_URL ??
      process.env.OLLAMA_BASE_URL ??
      'http://localhost:11434'
    ).replace(/\/+$/, '');
    const provider = createOpenAI({
      baseURL: `${base}/v1`,
      apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
    });
    return provider.textEmbeddingModel(
      process.env.OLLAMA_EMBEDDING_MODEL,
    ) as unknown as EmbeddingProvider;
  }
}

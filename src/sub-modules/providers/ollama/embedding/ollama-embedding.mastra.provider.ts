import {createOllama} from 'ollama-ai-provider';
import {Provider} from '@loopback/core';
import type {MastraEmbeddingModel} from '@mastra/core/vector';

/**
 * AI SDK / Mastra-shaped Ollama embedding provider. Bind to MastraEmbedder.
 * ollama-ai-provider currently ships V1 embedding models — accepted by
 * Mastra Memory via the legacy embedding code path.
 */
export class MastraOllamaEmbedding implements Provider<
  MastraEmbeddingModel<string>
> {
  value(): MastraEmbeddingModel<string> {
    if (!process.env.OLLAMA_EMBEDDING_MODEL) {
      throw new Error('OLLAMA_EMBEDDING_MODEL env var required');
    }
    const provider = createOllama({
      baseURL: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    });
    return provider.textEmbeddingModel(process.env.OLLAMA_EMBEDDING_MODEL);
  }
}

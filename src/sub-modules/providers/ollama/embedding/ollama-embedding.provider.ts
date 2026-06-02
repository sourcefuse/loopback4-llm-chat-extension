import {createOllama} from 'ollama-ai-provider';
import {Provider} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

export class OllamaEmbedding implements Provider<EmbeddingProvider> {
  value(): EmbeddingProvider {
    if (!process.env.OLLAMA_EMBEDDING_MODEL) {
      throw new Error('OLLAMA_EMBEDDING_MODEL environment variable is not set');
    }
    const provider = createOllama({
      baseURL: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    });
    return provider.textEmbeddingModel(
      process.env.OLLAMA_EMBEDDING_MODEL,
    ) as unknown as EmbeddingProvider;
  }
}

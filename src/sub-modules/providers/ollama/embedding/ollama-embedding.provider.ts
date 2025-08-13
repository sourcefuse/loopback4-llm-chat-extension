import {OllamaEmbeddings} from '@langchain/ollama';
import {Provider, ValueOrPromise} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

export class OllamaEmbedding implements Provider<EmbeddingProvider> {
  value(): ValueOrPromise<EmbeddingProvider> {
    if (!process.env.OLLAMA_EMBEDDING_MODEL) {
      throw new Error('OLLAMA_EMBEDDING_MODEL environment variable is not set');
    }
    return new OllamaEmbeddings({
      model: process.env.OLLAMA_EMBEDDING_MODEL!,
      baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    });
  }
}

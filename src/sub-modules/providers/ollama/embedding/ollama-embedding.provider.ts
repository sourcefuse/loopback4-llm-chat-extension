import {embed, embedMany} from 'ai';
import {createOllama} from 'ollama-ai-provider';
import {Provider, ValueOrPromise} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

type AiEmbeddingModel = Parameters<typeof embed>[0]['model'];

export class OllamaEmbedding implements Provider<EmbeddingProvider> {
  value(): ValueOrPromise<EmbeddingProvider> {
    if (!process.env.OLLAMA_EMBEDDING_MODEL) {
      throw new Error('OLLAMA_EMBEDDING_MODEL environment variable is not set');
    }

    const provider = createOllama({
      baseURL:
        process.env.OLLAMA_BASE_URL ??
        process.env.OLLAMA_URL ??
        'http://localhost:11434',
    });

    const model = provider.embedding(
      process.env.OLLAMA_EMBEDDING_MODEL,
    ) as unknown as AiEmbeddingModel;

    return {
      embedDocuments: async (texts: string[]) => {
        if (texts.length === 0) {
          return [];
        }
        const result = await embedMany({
          model,
          values: texts,
        });
        return result.embeddings.map(embedding => Array.from(embedding));
      },
      embedQuery: async (text: string) => {
        const result = await embed({
          model,
          value: text,
        });
        return Array.from(result.embedding);
      },
    } as EmbeddingProvider;
  }
}

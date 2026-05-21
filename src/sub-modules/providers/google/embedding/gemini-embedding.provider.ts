import {embed, embedMany} from 'ai';
import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {Provider} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

type AiEmbeddingModel = Parameters<typeof embed>[0]['model'];

export class GeminiEmbedding implements Provider<EmbeddingProvider> {
  value() {
    if (!process.env.GOOGLE_EMBEDDING_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'Google embedding model is not specified. Please set the GOOGLE_EMBEDDING_MODEL environment variable.',
      );
    }

    const provider = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });

    const model = provider.embeddingModel(
      process.env.GOOGLE_EMBEDDING_MODEL,
    ) as unknown as AiEmbeddingModel;

    return {
      embedDocuments: async (texts: string[]) => {
        if (texts.length === 0) {
          return [];
        }

        const result = await embedMany({
          model,
          values: texts,
          providerOptions: {
            google: {
              taskType: 'RETRIEVAL_DOCUMENT',
            },
          },
        });

        return result.embeddings.map(embedding => Array.from(embedding));
      },
      embedQuery: async (text: string) => {
        const result = await embed({
          model,
          value: text,
          providerOptions: {
            google: {
              taskType: 'RETRIEVAL_QUERY',
            },
          },
        });

        return Array.from(result.embedding);
      },
    } as EmbeddingProvider;
  }
}

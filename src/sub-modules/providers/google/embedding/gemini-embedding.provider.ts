import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {Provider} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

export class GeminiEmbedding implements Provider<EmbeddingProvider> {
  value(): EmbeddingProvider {
    if (!process.env.GOOGLE_EMBEDDING_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'Google embedding model is not specified. Please set the GOOGLE_EMBEDDING_MODEL environment variable.',
      );
    }

    const provider = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });
    return provider.textEmbeddingModel(process.env.GOOGLE_EMBEDDING_MODEL);
  }
}

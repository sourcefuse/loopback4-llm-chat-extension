import {TaskType} from '@google/generative-ai';
import {GoogleGenerativeAIEmbeddings} from '@langchain/google-genai';
import {Provider} from '@loopback/core';
import {EmbeddingProvider} from '../../../../types';

export class GeminiEmbedding implements Provider<EmbeddingProvider> {
  value() {
    if (!process.env.GOOGLE_EMBEDDING_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'Google embedding model is not specified. Please set the GOOGLE_EMBEDDING_MODEL environment variable.',
      );
    }

    return new GoogleGenerativeAIEmbeddings({
      model: process.env.GOOGLE_EMBEDDING_MODEL!,
      taskType: TaskType.RETRIEVAL_DOCUMENT,
      title: process.env.GOOGLE_EMBEDDING_TITLE ?? 'AI Integration Embedding',
    });
  }
}

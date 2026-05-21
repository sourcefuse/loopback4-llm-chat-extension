import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {Provider} from '@loopback/core';
import type {MastraEmbeddingModel} from '@mastra/core/vector';

/**
 * AI SDK / Mastra-shaped Gemini embedding provider. Bind to
 * MastraEmbedder. The legacy LangChain GoogleGenerativeAIEmbeddings
 * provider stays in place for v2 callsites until P3.
 */
export class MastraGeminiEmbedding implements Provider<
  MastraEmbeddingModel<string>
> {
  value(): MastraEmbeddingModel<string> {
    if (!process.env.GOOGLE_EMBEDDING_MODEL || !process.env.GOOGLE_API_KEY) {
      throw new Error(
        'GOOGLE_EMBEDDING_MODEL and GOOGLE_API_KEY env vars required',
      );
    }
    const provider = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
    });
    return provider.textEmbeddingModel(process.env.GOOGLE_EMBEDDING_MODEL);
  }
}

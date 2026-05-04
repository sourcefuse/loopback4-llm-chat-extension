import {createGoogleGenerativeAI} from '@ai-sdk/google';
import {Provider, ValueOrPromise} from '@loopback/core';
import {EmbeddingModel} from 'ai';

/**
 * AI SDK embedding provider for Google Gemini.
 *
 * Environment variables:
 *   - `GEMINI_EMBEDDING_MODEL` — e.g. `text-embedding-004`
 *   - `GOOGLE_GENERATIVE_AI_API_KEY`
 */
export class GeminiEmbeddingSdk implements Provider<EmbeddingModel> {
  value(): ValueOrPromise<EmbeddingModel> {
    const model = process.env.GEMINI_EMBEDDING_MODEL ?? 'text-embedding-004';
    const google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
    return google.textEmbeddingModel(model);
  }
}

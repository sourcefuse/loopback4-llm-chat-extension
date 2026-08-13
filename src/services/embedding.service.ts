/**
 * Embedding service.
 *
 * DI-managed wrapper over the Vercel AI SDK `embed` / `embedMany`, replacing
 * LangChain embeddings' `.embedQuery` / `.embedDocuments`. Injected by the
 * vector-store providers so embedding logic lives in a class, not free
 * functions.
 */
import {BindingScope, injectable} from '@loopback/core';
import {embed, embedMany, type EmbeddingModel} from 'ai';

@injectable({scope: BindingScope.SINGLETON})
export class EmbeddingService {
  /** Embeds a single string. */
  async embedText(model: EmbeddingModel, value: string): Promise<number[]> {
    const {embedding} = await embed({model, value});
    return embedding as number[];
  }

  /** Embeds many strings. */
  async embedTexts(
    model: EmbeddingModel,
    values: string[],
  ): Promise<number[][]> {
    const {embeddings} = await embedMany({model, values});
    return embeddings as number[][];
  }
}

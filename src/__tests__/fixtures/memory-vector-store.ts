import {EmbeddingService} from '../../services/embedding.service';
import {EmbeddingProvider} from '../../types';
import {Document, RetrieverFilter, VectorStore} from '../../vector';

const DEFAULT_K = 4;

/**
 * In-memory cosine-similarity vector store — a TEST DOUBLE only.
 *
 * The shipped library performs similarity search exclusively through pgvector's
 * DB operators (`PgVectorStoreImpl`, `<=>`). This fixture exists so unit tests
 * can exercise the retrieval flows without a live Postgres/pgvector instance; it
 * is bound in `test-app.ts` and never in production. It deliberately lives under
 * `__tests__/` so no hand-rolled vector math ships in the package.
 */
export class MemoryVectorStore extends VectorStore {
  private vectors: Array<{embedding: number[]; document: Document}> = [];

  constructor(embedder: EmbeddingService, embeddings: EmbeddingProvider) {
    super(embedder, embeddings);
  }

  async addDocuments(documents: Document[]): Promise<void> {
    const embeddings = await this.embedder.embedTexts(
      this.embeddings,
      documents.map(d => d.pageContent),
    );
    documents.forEach((document, index) => {
      this.vectors.push({embedding: embeddings[index], document});
    });
  }

  async similaritySearch(
    query: string,
    k = DEFAULT_K,
    filter?: RetrieverFilter,
  ): Promise<Document[]> {
    const queryEmbedding = await this.embedder.embedText(
      this.embeddings,
      query,
    );
    const predicate =
      typeof filter === 'function'
        ? filter
        : (doc: Document) => MemoryVectorStore.matchesObjectFilter(doc, filter);
    return this.vectors
      .filter(entry => predicate(entry.document))
      .map(entry => ({
        document: entry.document,
        score: MemoryVectorStore.cosineSimilarity(
          queryEmbedding,
          entry.embedding,
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(entry => entry.document);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async delete(_params?: any): Promise<void> {
    // no-op, matching the previous MemoryVectorStore override
  }

  private static cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private static matchesObjectFilter(
    doc: Document,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter?: Record<string, any>,
  ): boolean {
    if (!filter) {
      return true;
    }
    return Object.keys(filter).every(
      key => doc.metadata?.[key] === filter[key],
    );
  }
}

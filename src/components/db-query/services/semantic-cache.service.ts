import {embed} from 'ai';
import {BindingScope, inject, injectable} from '@loopback/core';
import type {
  MastraEmbeddingModel,
  MastraVector,
  QueryResult,
  VectorFilter,
} from '@mastra/core/vector';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryStoredTypes, SemanticCacheDocument} from '../types';

const SEMANTIC_CACHE_INDEX = 'semantic_cache';
const DEFAULT_TOP_K = 5;

type LegacyEmbedder = {
  embedDocuments(values: string[]): Promise<number[][]>;
};

function isLegacyEmbedder(value: unknown): value is LegacyEmbedder {
  return (
    typeof value === 'object' &&
    value !== null &&
    'embedDocuments' in value &&
    typeof (value as {embedDocuments?: unknown}).embedDocuments === 'function'
  );
}

@injectable({scope: BindingScope.SINGLETON})
export class SemanticCacheService {
  private indexReady = false;

  constructor(
    @inject(AiIntegrationBindings.VectorStore, {optional: true})
    private readonly vectorStore?: MastraVector,
    @inject(AiIntegrationBindings.EmbeddingModel, {optional: true})
    private readonly embedder?: MastraEmbeddingModel<string>,
  ) {}

  async search<TMetadata extends Record<string, unknown>>(
    query: string,
    args: {
      type: DbQueryStoredTypes;
      tenantId: string;
      topK?: number;
    },
  ): Promise<Array<SemanticCacheDocument<TMetadata>>> {
    if (!query || !this.vectorStore || !this.embedder || !args.tenantId) {
      return [];
    }
    try {
      const queryVector = await this.embedValue(query);
      await this.ensureIndex(queryVector.length);
      const results = await this.vectorStore.query({
        indexName: SEMANTIC_CACHE_INDEX,
        queryVector,
        topK: args.topK ?? DEFAULT_TOP_K,
        filter: {
          type: args.type,
          tenantId: args.tenantId,
        },
      });
      return results.map(result => this.toDocument<TMetadata>(result));
    } catch {
      return [];
    }
  }

  async upsertDocument(params: {
    pageContent: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    if (!this.vectorStore || !this.embedder) {
      return;
    }
    const pageContent = params.pageContent.trim();
    if (!pageContent) return;
    try {
      const vector = await this.embedValue(pageContent);
      await this.ensureIndex(vector.length);
      const metadata = {
        ...params.metadata,
        pageContent,
      };
      const id =
        typeof params.metadata.id === 'string' ? params.metadata.id : undefined;

      await this.vectorStore.upsert({
        indexName: SEMANTIC_CACHE_INDEX,
        vectors: [vector],
        metadata: [metadata],
        ids: id ? [id] : undefined,
      });
    } catch {
      return;
    }
  }

  async deleteByFilter(filter: VectorFilter): Promise<void> {
    if (!this.vectorStore) return;
    try {
      const indexes = await this.vectorStore.listIndexes();
      if (!indexes.includes(SEMANTIC_CACHE_INDEX)) return;
      await this.vectorStore.deleteVectors({
        indexName: SEMANTIC_CACHE_INDEX,
        filter,
      });
    } catch {
      return;
    }
  }

  private async ensureIndex(dimension: number): Promise<void> {
    if (!this.vectorStore || this.indexReady) return;
    const indexes = await this.vectorStore.listIndexes();
    if (indexes.includes(SEMANTIC_CACHE_INDEX)) {
      this.indexReady = true;
      return;
    }

    try {
      await this.vectorStore.createIndex({
        indexName: SEMANTIC_CACHE_INDEX,
        dimension,
        metric: 'cosine',
      });
      this.indexReady = true;
      return;
    } catch {
      const refreshedIndexes = await this.vectorStore.listIndexes();
      if (refreshedIndexes.includes(SEMANTIC_CACHE_INDEX)) {
        this.indexReady = true;
        return;
      }
      throw new Error(
        `Unable to create vector index ${SEMANTIC_CACHE_INDEX}. Ensure vector storage is configured correctly.`,
      );
    }
  }

  private async embedValue(value: string): Promise<number[]> {
    if (!this.embedder) {
      throw new Error(
        'Semantic cache requires AiIntegrationBindings.EmbeddingModel binding',
      );
    }
    if (isLegacyEmbedder(this.embedder)) {
      const vectors = await this.embedder.embedDocuments([value]);
      const [first] = vectors;
      if (!first) {
        throw new Error(
          'Embedding provider returned an empty embedding vector',
        );
      }
      return first;
    }
    const result = await embed({model: this.embedder, value});
    return result.embedding;
  }

  private toDocument<TMetadata extends Record<string, unknown>>(
    result: QueryResult,
  ): SemanticCacheDocument<TMetadata> {
    const metadata = {
      ...((result.metadata ?? {}) as Record<string, unknown>),
    };
    const pageContentFromMetadata =
      typeof metadata.pageContent === 'string' ? metadata.pageContent : '';
    delete metadata.pageContent;

    return {
      pageContent:
        pageContentFromMetadata ||
        (typeof result.document === 'string' ? result.document : ''),
      metadata: metadata as TMetadata,
    };
  }
}

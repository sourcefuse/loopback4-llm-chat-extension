import {embed} from 'ai';
import debugFactory from 'debug';
import {BindingScope, inject, injectable} from '@loopback/core';
import type {
  MastraEmbeddingModel,
  MastraVector,
  QueryResult,
  VectorFilter,
} from '@mastra/core/vector';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryStoredTypes, SemanticCacheDocument} from '../types';

const debug = debugFactory('ai-integration:semantic-cache');
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
    } catch (err) {
      // Read path is best-effort: a cache miss degrades to "no results"
      // rather than failing the request. But LOG it — a persistent
      // embedding-API/vector-store outage otherwise looks identical to a
      // steady stream of legitimate cache misses, with zero signal.
      debug('search degraded to empty (type=%s): %O', args.type, err);
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
    } catch (err) {
      // Write path is NOT best-effort: for templates the vector store is the
      // canonical persistence, so a swallowed failure would let the caller
      // (e.g. TemplateController.create) report HTTP 200 for a document that
      // was never stored — silent data loss. Surface it. Callers for whom
      // the write is genuinely optional (e.g. dataset vote-refresh) wrap
      // this in their own try/catch.
      debug('upsertDocument failed: %O', err);
      throw err;
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
    } catch (err) {
      // A delete that silently no-ops leaves stale / orphaned cache entries
      // (e.g. a removed template still surfacing in similarity search).
      // Surface it; the dataset vote-refresh caller treats it as best-effort.
      debug('deleteByFilter failed: %O', err);
      throw err;
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
    } catch (err) {
      // Absorb the concurrent-create race: another request may have created
      // the index between our listIndexes() and createIndex(). Re-check
      // before failing.
      const refreshedIndexes = await this.vectorStore.listIndexes();
      if (refreshedIndexes.includes(SEMANTIC_CACHE_INDEX)) {
        this.indexReady = true;
        return;
      }
      throw new Error(
        `Unable to create vector index ${SEMANTIC_CACHE_INDEX}. Ensure vector storage is configured correctly.`,
        {cause: err},
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

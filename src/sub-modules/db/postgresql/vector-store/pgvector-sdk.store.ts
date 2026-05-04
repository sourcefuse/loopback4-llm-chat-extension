import {embed, embedMany} from 'ai';
import {
  BindingScope,
  inject,
  injectable,
  Provider,
  ValueOrPromise,
} from '@loopback/core';
import {juggler} from '@loopback/repository';
import * as pg from 'pg';
import {AiIntegrationBindings} from '../../../../keys';
import {
  AiSdkEmbeddingModel,
  IVectorStore,
  IVectorStoreDocument,
} from '../../../../types';

const debug = require('debug')('mastra:db:pgvector-sdk');

/**
 * Name of the pgvector table shared with the LangChain `PgVectorStore`.
 * Both implementations target the same underlying schema so cached documents
 * written by either path are readable by the other.
 */
const TABLE_NAME = 'semantic_cache';

// ─── Internal implementation ──────────────────────────────────────────────────

/**
 * Internal stateless implementation of `IVectorStore` backed by a raw pg `Pool`.
 *
 * All embedding computation uses the AI SDK `embed()` / `embedMany()` helpers —
 * there is zero dependency on `@langchain/core` or any LangChain package.
 *
 * The table structure mirrors what `@langchain/community/vectorstores/pgvector`
 * creates so both execution paths can share the same persistent store:
 *
 * ```sql
 * CREATE TABLE {schema}.semantic_cache (
 *   id      uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
 *   content text,
 *   metadata jsonb,
 *   vector  vector
 * );
 * ```
 */
class PgVectorSdkStoreImpl implements IVectorStore {
  constructor(
    private readonly embeddingModel: AiSdkEmbeddingModel,
    private readonly pool: pg.Pool,
    private readonly schema: string,
  ) {}

  /**
   * Persist documents to the vector store.
   *
   * Embeddings are computed via `embedMany()` in a single batched call to reduce
   * round-trips to the embedding API.  Each document is then inserted with its
   * serialised metadata and pgvector-formatted embedding literal.
   *
   * @param docs - Array of `{pageContent, metadata}` objects to persist.
   */
  async addDocuments(docs: IVectorStoreDocument[]): Promise<void> {
    if (docs.length === 0) return;

    debug('addDocuments', {count: docs.length});

    const {embeddings} = await embedMany({
      model: this.embeddingModel,
      values: docs.map(d => d.pageContent),
    });

    const client = await this.pool.connect();
    try {
      for (let i = 0; i < docs.length; i++) {
        // pgvector expects the literal form "[f1,f2,...]"
        const vectorLiteral = `[${embeddings[i].join(',')}]`;
        await client.query(
          `INSERT INTO ${this.schema}.${TABLE_NAME} (id, content, metadata, vector)
           VALUES (gen_random_uuid(), $1, $2::jsonb, $3::vector)`,
          [
            docs[i].pageContent,
            JSON.stringify(docs[i].metadata),
            vectorLiteral,
          ],
        );
      }
    } finally {
      client.release();
    }
  }

  /**
   * Return the `k` most semantically similar documents to `query`.
   *
   * If `filter` is supplied it is applied as a PostgreSQL JSONB containment check
   * (`metadata @> filter::jsonb`) before ranking by cosine distance.
   *
   * @param query  - Natural-language query string.
   * @param k      - Maximum number of results to return.
   * @param filter - Optional key-value pairs that must all appear in document metadata.
   */
  async similaritySearch<T = Record<string, unknown>>(
    query: string,
    k: number,
    filter?: Record<string, unknown>,
  ): Promise<IVectorStoreDocument<T>[]> {
    debug('similaritySearch', {k, filter});

    const {embedding} = await embed({
      model: this.embeddingModel,
      value: query,
    });

    const vectorLiteral = `[${embedding.join(',')}]`;

    const params: unknown[] = [vectorLiteral];
    let filterClause = '';
    if (filter && Object.keys(filter).length > 0) {
      params.push(JSON.stringify(filter));
      filterClause = `WHERE metadata @> $2::jsonb`;
    }
    params.push(k);

    const limitParam = `$${params.length}`;
    const sql = `
      SELECT content, metadata
      FROM ${this.schema}.${TABLE_NAME}
      ${filterClause}
      ORDER BY vector <=> $1::vector
      LIMIT ${limitParam}
    `;

    const {rows} = await this.pool.query(sql, params);

    return rows.map(row => ({
      pageContent: row.content as string,
      metadata: row.metadata as T,
    }));
  }

  /**
   * Delete all documents whose metadata satisfies the given JSON containment filter.
   *
   * @param params.filter - Key-value pairs used to match documents for deletion.
   */
  async delete(params: {filter: Record<string, unknown>}): Promise<void> {
    debug('delete', {filter: params.filter});

    await this.pool.query(
      `DELETE FROM ${this.schema}.${TABLE_NAME} WHERE metadata @> $1::jsonb`,
      [JSON.stringify(params.filter)],
    );
  }
}

// ─── LoopBack provider ────────────────────────────────────────────────────────

/**
 * LoopBack provider that creates and returns a Mastra-path `IVectorStore` backed
 * by PostgreSQL + pgvector.
 *
 * **Binding**: register in your component's `providers` map under
 * `AiIntegrationBindings.AiSdkVectorStore`.
 *
 * **Prerequisites**:
 * - The `vector` PostgreSQL extension must be installed.
 * - The `semantic_cache` table must exist in the configured schema (it is
 *   created automatically by `PgVectorStore` on the LangGraph path, or by
 *   running the project migration).
 * - `AiIntegrationBindings.AiSdkEmbeddingModel` must be bound to an AI SDK
 *   `EmbeddingModel<string>` (e.g. `openai.embedding('text-embedding-3-small')`).
 * - The `datasources.writerdb` LoopBack datasource must use the `loopback-connector-postgresql`
 *   connector so that `connector.pg` exposes a `pg.Pool`.
 *
 * Environment variables (same as `PgVectorStore`):
 * - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_DATABASE` (validated at startup).
 */
@injectable({scope: BindingScope.SINGLETON})
export class PgVectorSdkStore implements Provider<IVectorStore> {
  constructor(
    @inject(AiIntegrationBindings.AiSdkEmbeddingModel)
    private readonly embeddingModel: AiSdkEmbeddingModel,
    @inject(`datasources.writerdb`)
    private readonly pgDataSource: juggler.DataSource,
  ) {}

  /**
   * Instantiate and return the vector store implementation.
   *
   * Reads the pg `Pool` and schema name from the injected LoopBack datasource
   * so that the same connection pool is shared with the rest of the application —
   * no extra connections are opened.
   */
  value(): ValueOrPromise<IVectorStore> {
    if (
      !process.env.DB_HOST ||
      !process.env.DB_PORT ||
      !process.env.DB_USER ||
      !process.env.DB_DATABASE
    ) {
      throw new Error(
        'Database connection details are not set. ' +
          'Please set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_DATABASE environment variables.',
      );
    }

    const pool = this.pgDataSource.connector?.pg as pg.Pool;
    const dsConfig = this.pgDataSource.connector?.settings as
      | {schema?: string}
      | undefined;
    const schema = dsConfig?.schema ?? 'public';

    debug('PgVectorSdkStore initialised', {schema});
    return new PgVectorSdkStoreImpl(this.embeddingModel, pool, schema);
  }
}

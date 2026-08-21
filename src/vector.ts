/**
 * Internal vector-store primitives.
 *
 * Replaces `@langchain/core/{documents,vectorstores,retrievers}` and the
 * `@langchain/community` / `@langchain/classic` stores with a minimal surface
 * that mirrors exactly what the codebase uses (`Document`, `VectorStore`,
 * `BaseRetriever`, `asRetriever`, `addDocuments`, `similaritySearch`, `delete`).
 * Embeddings go through the AI SDK; the Postgres store talks to the existing
 * `semantic_cache` table directly (via the shared pg pool) so the table schema
 * and migrations are unchanged.
 */
import * as pg from 'pg';
import {EmbeddingService} from './services/embedding.service';
import {EmbeddingProvider} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Document<M extends Record<string, any> = Record<string, any>> {
  pageContent: string;
  metadata: M;
}

export type RetrieverFilter =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Record<string, any> | ((doc: Document) => boolean);

export interface RetrieverOptions {
  k?: number;
  filter?: RetrieverFilter;
  searchType?: string;
}

export interface BaseRetriever<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  M extends Record<string, any> = Record<string, any>,
> {
  invoke(query: string, config?: unknown): Promise<Document<M>[]>;
  getRelevantDocuments(query: string, config?: unknown): Promise<Document<M>[]>;
}

/** Back-compat alias for the LangChain `DocumentInterface` name. */
export type DocumentInterface<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  M extends Record<string, any> = Record<string, any>,
> = Document<M>;

const DEFAULT_K = 4;

export abstract class VectorStore {
  constructor(
    protected readonly embedder: EmbeddingService,
    protected readonly embeddings: EmbeddingProvider,
  ) {}

  abstract addDocuments(documents: Document[]): Promise<void>;
  abstract similaritySearch(
    query: string,
    k?: number,
    filter?: RetrieverFilter,
  ): Promise<Document[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract delete(params?: any): Promise<void>;

  asRetriever(options: RetrieverOptions = {}): BaseRetriever {
    const search = (query: string) =>
      this.similaritySearch(query, options.k ?? DEFAULT_K, options.filter);
    return {
      invoke: search,
      getRelevantDocuments: search,
    };
  }
}

export interface PgVectorStoreConfig {
  pool: pg.Pool;
  schemaName: string;
  tableName: string;
}

/**
 * Postgres/pgvector store backed by the existing `semantic_cache` table
 * (columns `id`, `vector`, `content`, `metadata`). Uses cosine distance
 * (`<=>`) and JSONB containment for metadata filters.
 */
interface TableColumns {
  id: string;
  content: string;
  vector: string;
  metadata: string;
}

export class PgVectorStoreImpl extends VectorStore {
  private ensured?: Promise<void>;
  // Defaults used when creating a fresh table; overwritten by column detection
  // when the table already exists (e.g. created by the old LangChain store).
  private cols: TableColumns = {
    id: 'id',
    content: 'content',
    vector: 'vector',
    metadata: 'metadata',
  };
  // Schema where the pgvector extension (the `vector` type + `<=>` operator)
  // lives, so queries can fully-qualify them regardless of search_path.
  private vectorSchema?: string;

  constructor(
    embedder: EmbeddingService,
    embeddings: EmbeddingProvider,
    private readonly config: PgVectorStoreConfig,
  ) {
    super(embedder, embeddings);
  }

  private get qualifiedTable(): string {
    return `"${this.config.schemaName}"."${this.config.tableName}"`;
  }

  /** The `vector` type, schema-qualified when the extension schema is known. */
  private get vectorType(): string {
    return this.vectorSchema ? `"${this.vectorSchema}".vector` : 'vector';
  }

  /** The cosine-distance operator, schema-qualified when possible. */
  private get distanceOp(): string {
    return this.vectorSchema ? `OPERATOR("${this.vectorSchema}".<=>)` : '<=>';
  }

  /**
   * Lazily ensures the backing table is usable. The previous
   * `@langchain/community` `PGVectorStore.initialize()` auto-created this table
   * at runtime (it is not in the migrations). If it already exists, we detect
   * the actual content/vector/metadata column names (which may differ from our
   * defaults); otherwise we create it.
   */
  private ensureTable(): Promise<void> {
    if (!this.ensured) {
      this.ensured = this._ensureTable();
    }
    return this.ensured;
  }

  private async _ensureTable(): Promise<void> {
    // Locate the schema the pgvector extension was installed into.
    const ext = await this.config.pool.query(
      `SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector' LIMIT 1`,
    );
    this.vectorSchema = ext.rows[0]?.schema as string | undefined;

    const existing = await this.config.pool.query(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [this.config.schemaName, this.config.tableName],
    );

    if (existing.rows.length === 0) {
      await this.config.pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.qualifiedTable} (` +
          `"${this.cols.id}" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, ` +
          `"${this.cols.content}" text, "${this.cols.metadata}" jsonb, ` +
          `"${this.cols.vector}" ${this.vectorType})`,
      );
      return;
    }

    // Adapt to the existing table's column names, matched by data type.
    // (Row keys are Postgres snake_case: column_name / data_type / udt_name.)
    const rows = existing.rows as Array<Record<string, string>>;
    for (const row of rows) {
      if (row.udt_name === 'vector') {
        this.cols.vector = row.column_name;
      } else if (row.data_type === 'jsonb' || row.data_type === 'json') {
        this.cols.metadata = row.column_name;
      } else if (row.udt_name === 'uuid') {
        this.cols.id = row.column_name;
      } else if (
        (row.data_type === 'text' || row.data_type === 'character varying') &&
        row.column_name !== this.cols.id
      ) {
        this.cols.content = row.column_name;
      } else {
        // Unrecognized column — leave the default column mapping untouched.
      }
    }
  }

  async addDocuments(documents: Document[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    await this.ensureTable();
    const embeddings = await this.embedder.embedTexts(
      this.embeddings,
      documents.map(d => d.pageContent),
    );
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      await this.config.pool.query(
        `INSERT INTO ${this.qualifiedTable} ("${this.cols.vector}", "${this.cols.content}", "${this.cols.metadata}") VALUES ($1::${this.vectorType}, $2, $3)`,
        [
          PgVectorStoreImpl.toVectorLiteral(embeddings[i]),
          doc.pageContent,
          JSON.stringify(doc.metadata ?? {}),
        ],
      );
    }
  }

  async similaritySearch(
    query: string,
    k = DEFAULT_K,
    filter?: RetrieverFilter,
  ): Promise<Document[]> {
    await this.ensureTable();
    const queryEmbedding = await this.embedder.embedText(
      this.embeddings,
      query,
    );
    const params: unknown[] = [
      PgVectorStoreImpl.toVectorLiteral(queryEmbedding),
    ];
    let where = '';
    if (filter && typeof filter !== 'function') {
      params.push(JSON.stringify(filter));
      where = `WHERE "${this.cols.metadata}" @> $${params.length}::jsonb`;
    }
    params.push(k);
    // The vector cast + `<=>` operator are schema-qualified (see `vectorType`/
    // `distanceOp`) so they resolve regardless of the connection's search_path.
    const result = await this.config.pool.query(
      `SELECT "${this.cols.content}" AS content, "${this.cols.metadata}" AS metadata FROM ${this.qualifiedTable} ${where} ORDER BY "${this.cols.vector}" ${this.distanceOp} $1::${this.vectorType} LIMIT $${params.length}`,
      params,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows.map((row: any) => ({
      pageContent: row.content,
      metadata:
        typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : (row.metadata ?? {}),
    }));
  }

  async delete(params?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter?: Record<string, any>;
    ids?: string[];
  }): Promise<void> {
    await this.ensureTable();
    if (params?.ids && params.ids.length > 0) {
      await this.config.pool.query(
        `DELETE FROM ${this.qualifiedTable} WHERE "${this.cols.id}" = ANY($1)`,
        [params.ids],
      );
      return;
    }
    if (params?.filter) {
      await this.config.pool.query(
        `DELETE FROM ${this.qualifiedTable} WHERE "${this.cols.metadata}" @> $1::jsonb`,
        [JSON.stringify(params.filter)],
      );
    }
  }

  private static toVectorLiteral(embedding: number[]): string {
    return `[${embedding.join(',')}]`;
  }
}

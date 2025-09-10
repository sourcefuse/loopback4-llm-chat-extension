import {
  PGVectorStore as PGStore,
  PGVectorStoreArgs,
} from '@langchain/community/vectorstores/pgvector';
import {VectorStore} from '@langchain/core/vectorstores';
import {
  BindingScope,
  inject,
  injectable,
  Provider,
  ValueOrPromise,
} from '@loopback/core';
import * as pg from 'pg';
import {EmbeddingProvider} from '../../../../types';
import {AiIntegrationBindings} from '../../../../keys';
@injectable({scope: BindingScope.SINGLETON})
export class PgVectorStore implements Provider<VectorStore> {
  constructor(
    @inject(AiIntegrationBindings.EmbeddingModel)
    private readonly embeddingModel: EmbeddingProvider,
  ) {}
  value(): ValueOrPromise<VectorStore> {
    if (
      !process.env.DB_HOST ||
      !process.env.DB_PORT ||
      !process.env.DB_USER ||
      !process.env.DB_DATABASE
    ) {
      throw new Error(
        'Database connection details are not set. Please set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_DATABASE environment variables.',
      );
    }
    const reusablePool = new pg.Pool({
      host: process.env.DB_HOST!,
      port: +process.env.DB_PORT!,
      user: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      database: process.env.DB_DATABASE!,
    });

    const config: PGVectorStoreArgs = {
      pool: reusablePool,
      tableName: 'context',
      collectionName: 'knowledge_base',
      collectionTableName: 'embeddings_collections',
      extensionSchemaName: process.env.DB_SCHEMA || 'public',
      columns: {
        idColumnName: 'id',
        vectorColumnName: 'vector',
        contentColumnName: 'content',
        metadataColumnName: 'metadata',
      },
    };
    return PGStore.initialize(this.embeddingModel, config);
  }
}

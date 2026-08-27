import {
  BindingScope,
  inject,
  injectable,
  Provider,
  service,
  ValueOrPromise,
} from '@loopback/core';
import * as pg from 'pg';
import {EmbeddingProvider} from '../../../../types';
import {AiIntegrationBindings} from '../../../../keys';
import {juggler} from '@loopback/repository';
import {EmbeddingService} from '../../../../services/embedding.service';
import {PgVectorStoreImpl, VectorStore} from '../../../../vector';

@injectable({scope: BindingScope.SINGLETON})
export class PgVectorStore implements Provider<VectorStore> {
  constructor(
    @service(EmbeddingService)
    private readonly embedder: EmbeddingService,
    @inject(AiIntegrationBindings.EmbeddingModel)
    private readonly embeddingModel: EmbeddingProvider,
    @inject(`datasources.writerdb`)
    private pgDataSource: juggler.DataSource,
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
    const reusablePool = this.pgDataSource.connector?.pg as pg.Pool;
    const dsConfig = this.pgDataSource.connector?.settings;

    return new PgVectorStoreImpl(this.embedder, this.embeddingModel, {
      pool: reusablePool,
      schemaName: dsConfig.schema || 'public',
      tableName: 'semantic_cache',
    });
  }
}

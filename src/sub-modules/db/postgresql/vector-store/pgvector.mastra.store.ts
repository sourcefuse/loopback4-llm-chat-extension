import {PgVector} from '@mastra/pg';
import {
  BindingScope,
  inject,
  injectable,
  Provider,
  ValueOrPromise,
} from '@loopback/core';
import {juggler} from '@loopback/repository';
import type {MastraVector} from '@mastra/core/vector';

/**
 * AI SDK / Mastra-shaped PgVector store. Bind to MastraVectorStore.
 *
 * Note: @mastra/pg PgVector manages its own pg.Pool internally (it does
 * not accept a pre-built pool the way the legacy @langchain/community
 * PGVectorStore did). Consumers running both the legacy store and this
 * one against the same PG instance therefore hold TWO connection pools
 * during the transition window — acceptable for P1, expected to be
 * single-pool again once the legacy provider is dropped in P3.
 *
 * The schemaName falls back to the juggler datasource's schema, mirroring
 * the legacy provider so vector tables land in the same schema consumers
 * already provisioned. Set `MASTRA_PGVECTOR_SCHEMA` to override.
 *
 * Refs: MIGRATION-STRATEGY.md sections 13.8, 13.8a.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraPgVectorStore implements Provider<MastraVector> {
  constructor(
    @inject(`datasources.writerdb`)
    private pgDataSource: juggler.DataSource,
  ) {}

  value(): ValueOrPromise<MastraVector> {
    if (
      !process.env.DB_HOST ||
      !process.env.DB_PORT ||
      !process.env.DB_USER ||
      !process.env.DB_DATABASE
    ) {
      throw new Error(
        'DB env vars not set. Required: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_DATABASE.',
      );
    }
    const dsSchema = this.pgDataSource.connector?.settings?.schema as
      | string
      | undefined;
    return new PgVector({
      id: 'mastra-pgvector',
      connectionString: this.buildConnString(),
      schemaName: process.env.MASTRA_PGVECTOR_SCHEMA ?? dsSchema ?? 'public',
    });
  }

  private buildConnString(): string {
    const {DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_DATABASE} = process.env;
    return `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_DATABASE}`;
  }
}

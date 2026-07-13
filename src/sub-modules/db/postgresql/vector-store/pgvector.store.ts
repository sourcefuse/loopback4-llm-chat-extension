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
 * True when the DB_* env vars needed to back {@link PgVectorStore} are all set.
 * Lives next to the store it guards (not in the root component) so the pgvector
 * env contract stays in one place.
 */
export function hasPgVectorEnv(): boolean {
  return Boolean(
    process.env.DB_HOST &&
    process.env.DB_PORT &&
    process.env.DB_USER &&
    process.env.DB_PASSWORD &&
    process.env.DB_DATABASE,
  );
}

@injectable({scope: BindingScope.SINGLETON})
export class PgVectorStore implements Provider<MastraVector> {
  constructor(
    @inject(`datasources.writerdb`)
    private pgDataSource: juggler.DataSource,
  ) {}

  value(): ValueOrPromise<MastraVector> {
    if (
      !process.env.DB_HOST ||
      !process.env.DB_PORT ||
      !process.env.DB_USER ||
      !process.env.DB_PASSWORD ||
      !process.env.DB_DATABASE
    ) {
      throw new Error(
        'DB env vars not set. Required: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_DATABASE.',
      );
    }

    const dsSchema = this.pgDataSource.connector?.settings?.schema as
      string | undefined;
    return new PgVector({
      id: 'mastra-pgvector',
      connectionString: this.buildConnString(),
      schemaName: process.env.MASTRA_PGVECTOR_SCHEMA ?? dsSchema ?? 'public',
    });
  }

  private buildConnString(): string {
    const user = encodeURIComponent(process.env.DB_USER!);
    const password = encodeURIComponent(process.env.DB_PASSWORD!);
    const host = encodeURIComponent(process.env.DB_HOST!);
    const port = encodeURIComponent(process.env.DB_PORT!);
    const database = encodeURIComponent(process.env.DB_DATABASE!);
    return `postgresql://${user}:${password}@${host}:${port}/${database}`;
  }
}

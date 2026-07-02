import {BindingScope, inject, injectable, Provider} from '@loopback/core';
import {LibSQLStore} from '@mastra/libsql';
import {PostgresStore} from '@mastra/pg';
import type {MastraCompositeStore} from '@mastra/core/storage';
import {AiIntegrationBindings} from '../../keys';
import type {AIIntegrationConfig, MastraStorageConfig} from '../../types';

const DEFAULT_PG_SCHEMA = 'mastra';

/**
 * Default Mastra storage provider. Picks the backend from the `storage` field
 * on `AiIntegrationBindings.Config` — the same config binding consumers already
 * use for `writerDS`/`readerDS`/`tokenCounterConfig` — so no separate component
 * or internal binding is needed to switch storage:
 *
 * ```ts
 * this.bind(AiIntegrationBindings.Config).to({
 *   ...existing,
 *   storage: {type: 'postgres', connectionString: process.env.MASTRA_PG_CONNECTION_STRING},
 * });
 * ```
 *
 * Zero-config default is LibSQL/SQLite (`file:./mastra.db`). Env vars remain a
 * fallback for both backends (`MASTRA_STORAGE_URL`, `MASTRA_PG_CONNECTION_STRING`);
 * a bare `MASTRA_PG_CONNECTION_STRING` with no `storage.type` also selects
 * Postgres, so existing env-only setups keep working.
 */
@injectable({scope: BindingScope.SINGLETON})
export class DefaultStorageProvider implements Provider<MastraCompositeStore> {
  constructor(
    @inject(AiIntegrationBindings.Config, {optional: true})
    private readonly config?: AIIntegrationConfig,
  ) {}

  async value(): Promise<MastraCompositeStore> {
    const storage = this.config?.storage;
    const wantsPostgres =
      storage?.type === 'postgres' ||
      (!storage?.type && Boolean(process.env.MASTRA_PG_CONNECTION_STRING));
    if (wantsPostgres) {
      return this.buildPostgres(storage);
    }
    return new LibSQLStore({
      id: 'mastra-default',
      url:
        storage?.connectionString ??
        process.env.MASTRA_STORAGE_URL ??
        'file:./mastra.db',
    });
  }

  private buildPostgres(storage?: MastraStorageConfig): MastraCompositeStore {
    const connectionString =
      storage?.connectionString ?? process.env.MASTRA_PG_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error(
        'storage.type is "postgres" but no connection string was provided ' +
          '(config.storage.connectionString or MASTRA_PG_CONNECTION_STRING). ' +
          'Refusing to start without an explicit Postgres configuration.',
      );
    }
    const ssl =
      storage?.ssl ?? (process.env.MASTRA_PG_SSL === 'true' ? true : undefined);
    return new PostgresStore({
      id: process.env.MASTRA_STORAGE_ID ?? 'mastra-pg',
      schemaName:
        storage?.schema ?? process.env.MASTRA_PG_SCHEMA ?? DEFAULT_PG_SCHEMA,
      connectionString,
      ssl,
    });
  }
}

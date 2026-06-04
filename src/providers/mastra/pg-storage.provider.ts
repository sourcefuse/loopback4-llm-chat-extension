import {BindingScope, injectable, Provider} from '@loopback/core';
import {PostgresStore} from '@mastra/pg';
import type {MastraCompositeStore} from '@mastra/core/storage';

/**
 * Postgres-backed Mastra storage provider (issue #17). Ships `@mastra/pg`'s
 * `PostgresStore` — which extends `MastraCompositeStore` — so it is a drop-in
 * for the `MastraInternalBindings.Storage` binding, persisting threads,
 * messages and (when enabled) working memory in Postgres instead of the
 * default LibSQL/SQLite file.
 *
 * NOT bound by default — {@link DefaultMastraStorageProvider} (LibSQL) stays
 * the zero-config default. Opt in from the consumer app:
 *
 * ```ts
 * import {PostgresMastraStorageProvider, MastraInternalBindings} from
 *   'lb4-llm-chat-component';
 * app.bind(MastraInternalBindings.Storage).toProvider(PostgresMastraStorageProvider);
 * ```
 *
 * Configuration is read from env, supporting either form `@mastra/pg` accepts:
 *
 *   1. Connection string — `MASTRA_PG_CONNECTION_STRING`
 *      (e.g. `postgresql://user:pass@host:5432/db`)
 *   2. Discrete host fields — `MASTRA_PG_HOST`, `MASTRA_PG_PORT` (default 5432),
 *      `MASTRA_PG_DATABASE`, `MASTRA_PG_USER`, `MASTRA_PG_PASSWORD`
 *
 * Optional, both forms:
 *   - `MASTRA_PG_SCHEMA`   schema for the mastra_* tables (default `mastra`)
 *   - `MASTRA_PG_SSL`      `true` to enable TLS
 *   - `MASTRA_STORAGE_ID`  store id (default `mastra-pg`)
 *
 * Fail-closed: throws a descriptive error when neither a connection string nor
 * a complete host config is present, rather than silently falling back to a
 * different backend.
 */
@injectable({scope: BindingScope.SINGLETON})
export class PostgresMastraStorageProvider implements Provider<MastraCompositeStore> {
  async value(): Promise<MastraCompositeStore> {
    const id = process.env.MASTRA_STORAGE_ID ?? 'mastra-pg';
    const schemaName = process.env.MASTRA_PG_SCHEMA ?? 'mastra';
    const ssl = process.env.MASTRA_PG_SSL === 'true' ? true : undefined;

    const connectionString = process.env.MASTRA_PG_CONNECTION_STRING;
    if (connectionString) {
      return new PostgresStore({id, schemaName, connectionString, ssl});
    }

    const host = process.env.MASTRA_PG_HOST;
    const database = process.env.MASTRA_PG_DATABASE;
    const user = process.env.MASTRA_PG_USER;
    const password = process.env.MASTRA_PG_PASSWORD;
    if (host && database && user && password !== undefined) {
      return new PostgresStore({
        id,
        schemaName,
        host,
        port: Number(process.env.MASTRA_PG_PORT ?? 5432),
        database,
        user,
        password,
        ssl,
      });
    }

    throw new Error(
      'PostgresMastraStorageProvider: set MASTRA_PG_CONNECTION_STRING, or all ' +
        'of MASTRA_PG_HOST / MASTRA_PG_DATABASE / MASTRA_PG_USER / ' +
        'MASTRA_PG_PASSWORD. Refusing to start without an explicit Postgres ' +
        'configuration (no silent fallback to another storage backend).',
    );
  }
}

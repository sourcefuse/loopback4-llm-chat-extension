import {Component, CoreBindings, inject, Application} from '@loopback/core';
import {AiIntegrationBindings} from '../../keys';
import {PostgresStorageProvider} from './pg-storage.provider';

/**
 * Opt-in Postgres-backed Mastra storage (issue #17).
 *
 * Registering this component points `AiIntegrationBindings.Storage` at
 * {@link PostgresStorageProvider}, so the consumer never has to import the
 * internal binding key to switch storage backends — the same way a consumer
 * mounts any other feature component:
 *
 * ```ts
 * import {PostgresStorageComponent} from 'lb4-llm-chat-component';
 * this.component(PostgresStorageComponent);
 * ```
 *
 * Without it, the zero-config LibSQL/SQLite default (`DefaultStorageProvider`)
 * stays in effect. Connection config is read from env by the provider
 * (`MASTRA_PG_CONNECTION_STRING`, or the discrete `MASTRA_PG_*` fields).
 */
export class PostgresStorageComponent implements Component {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly application: Application,
  ) {
    this.application
      .bind(AiIntegrationBindings.Storage)
      .toProvider(PostgresStorageProvider);
  }
}

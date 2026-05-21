import {BindingScope, injectable, Provider} from '@loopback/core';
import {LibSQLStore} from '@mastra/libsql';
import type {MastraCompositeStore} from '@mastra/core/storage';

/**
 * Default Mastra storage provider — ships @mastra/libsql writing to a local
 * SQLite file. Zero-config so the component works out-of-the-box. Consumers
 * override via `app.bind(AiIntegrationBindings.MastraStorage).to(...)` with
 * PostgresStore, MongoDBStore, etc. See MIGRATION-STRATEGY.md Section 13.
 */
@injectable({scope: BindingScope.SINGLETON})
export class DefaultMastraStorageProvider implements Provider<MastraCompositeStore> {
  async value(): Promise<MastraCompositeStore> {
    return new LibSQLStore({
      id: 'mastra-default',
      url: process.env.MASTRA_STORAGE_URL ?? 'file:./mastra.db',
    });
  }
}

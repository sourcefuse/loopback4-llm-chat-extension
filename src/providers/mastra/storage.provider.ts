import {BindingScope, injectable, Provider} from '@loopback/core';
import type {MastraCompositeStore} from '@mastra/core/storage';
import {LibSQLStore} from '@mastra/libsql';

@injectable({scope: BindingScope.SINGLETON})
export class DefaultMastraStorageProvider implements Provider<MastraCompositeStore> {
  async value(): Promise<MastraCompositeStore> {
    return new LibSQLStore({
      id: 'mastra-default',
      url: process.env.MASTRA_STORAGE_URL ?? 'file:./mastra.db',
    });
  }
}

import {inject, LifeCycleObserver, service} from '@loopback/core';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbSchemaHelperService} from '../services';
import {SchemaStore} from '../services/schema.store';
import {TableSearchService} from '../services/search/table-search.service';
import {DbQueryConfig} from '../types';

export class TableSeedObserver implements LifeCycleObserver {
  constructor(
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @service(DbSchemaHelperService)
    private readonly dbSchemaHelper: DbSchemaHelperService,
    @service(SchemaStore)
    private readonly schemaStore: SchemaStore,
    @service(TableSearchService)
    private readonly tableSearchService: TableSearchService,
  ) {}
  async start(): Promise<void> {
    const dbSchema = this.dbSchemaHelper.modelToSchema(
      this.config.db?.schema ?? 'public',
      this.config.models.map(v => v.model) ?? [],
    );

    await this.schemaStore.save(dbSchema);

    await this.tableSearchService.seedTables(dbSchema);
  }
}

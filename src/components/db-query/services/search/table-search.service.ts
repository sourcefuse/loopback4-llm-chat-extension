import {BindingScope, inject, injectable, service} from '@loopback/core';
import {ILogger, LOGGER} from '@sourceloop/core';
import {AiIntegrationBindings} from '../../../../keys';
import {ICache} from '../../../../types';
import {DbQueryAIExtensionBindings} from '../../keys';
import {
  CachedKnowledgeGraph,
  DatabaseSchema,
  DbQueryConfig,
  DbQueryStoredTypes,
} from '../../types';
import {DbSchemaHelperService} from '../db-schema-helper.service';
import {KnowledgeGraph} from '../knowledge-graph';

@injectable({scope: BindingScope.SINGLETON})
export class TableSearchService {
  private _tables: string[] = [];
  constructor(
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @inject(LOGGER.LOGGER_INJECT)
    private readonly logger: ILogger,
    @inject(DbQueryAIExtensionBindings.DbKnowledgeGraph)
    private readonly knowledgeGraphService: KnowledgeGraph<
      string,
      DatabaseSchema
    >,
    @inject(AiIntegrationBindings.Cache)
    private readonly cache: ICache,
    @service(DbSchemaHelperService)
    private readonly dbSchemaHelper: DbSchemaHelperService,
  ) {}

  async getTables(prompt: string, count: number): Promise<string[]> {
    if (this.config.noKnowledgeGraph) {
      return this._tables;
    }
    return this.knowledgeGraphService.find(prompt, count);
  }

  async seedTables(dbSchema: DatabaseSchema) {
    if (this.config.noKnowledgeGraph) {
      this._tables = Object.keys(dbSchema.tables);
      return;
    }
    const hash = this.dbSchemaHelper.computeHash(dbSchema);
    const existing = await this.cache.get<CachedKnowledgeGraph>(
      DbQueryStoredTypes.KnowledgeGraph,
    );
    if (existing && existing.hash === hash) {
      this.knowledgeGraphService.fromJSON(existing.graph);
      // If the knowledge graph already exists, we can skip seeding it again
      this.logger.info(
        'Knowledge graph already exists in cache, loading from cache.',
      );
    } else {
      this.logger.info('Seeding knowledge graph with database schema...');
      await this.knowledgeGraphService.seed(dbSchema);
      const graph = this.knowledgeGraphService.toJSON();
      await this.cache.set<CachedKnowledgeGraph>(
        DbQueryStoredTypes.KnowledgeGraph,
        {hash, graph},
      );
      this.logger.info('Knowledge graph built successfully.');
    }
  }
}

import {
  Binding,
  Component,
  Constructor,
  ControllerClass,
  createBindingFromClass,
  LifeCycleObserver,
  ProviderMap,
  ServiceOrProviderClass,
} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {PgConnector} from './connectors';
import {DataSetController} from './controller';
import {DatasetServiceComponent} from './dataset-service.component';
import {DbQueryGraph} from './db-query.graph';
import {DbQueryAIExtensionBindings} from './keys';
import {
  CheckCacheNode,
  CheckPermissionsNode,
  FailedNode,
  GetTablesNode,
  IsImprovementNode,
  SaveDataSetNode,
  SemanticValidatorNode,
  SqlGenerationNode,
  SyntacticValidatorNode,
} from './nodes';
import {TableSeedObserver} from './observers';
import {DatasetRetriever} from './providers';
import {DataSetHelper, DbSchemaHelperService} from './services';
import {PermissionHelper} from './services/permission-helper.service';
import {SchemaStore} from './services/schema.store';
import {TableSearchService} from './services/search/table-search.service';
import {
  AskAboutDatasetTool,
  GenerateQueryTool,
  ImproveQueryTool,
} from './tools';

export class DbQueryComponent implements Component {
  services: ServiceOrProviderClass[] | undefined;
  controllers: ControllerClass[] | undefined;
  components: Constructor<Component>[] | undefined;
  providers: ProviderMap | undefined;
  bindings: Binding<AnyObject>[] | undefined;
  lifeCycleObservers: Constructor<LifeCycleObserver>[] | undefined;
  constructor() {
    this.controllers = [DataSetController];
    this.providers = {
      [DbQueryAIExtensionBindings.QueryCache.key]: DatasetRetriever,
    };
    this.bindings = [
      createBindingFromClass(PgConnector, {
        key: DbQueryAIExtensionBindings.Connector.key,
      }),
    ];
    this.lifeCycleObservers = [TableSeedObserver];
    this.services = [
      // db related
      DbSchemaHelperService,
      PermissionHelper,
      DataSetHelper,
      SchemaStore,
      TableSearchService,
      // graph
      DbQueryGraph,
      // tools
      AskAboutDatasetTool,
      GenerateQueryTool,
      ImproveQueryTool,
      // nodes
      IsImprovementNode,
      GetTablesNode,
      CheckPermissionsNode,
      SqlGenerationNode,
      SyntacticValidatorNode,
      SemanticValidatorNode,
      FailedNode,
      SaveDataSetNode,
      CheckCacheNode,
    ];
    this.components = [DatasetServiceComponent];
  }
}

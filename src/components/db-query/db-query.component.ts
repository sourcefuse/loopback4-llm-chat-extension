import {
  Binding,
  BindingScope,
  Component,
  Constructor,
  ControllerClass,
  createBindingFromClass,
  LifeCycleObserver,
  ProviderMap,
  ServiceOrProviderClass,
} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {DataSetController, TemplateController} from './controller';
import {DatasetServiceComponent} from './dataset-service.component';
import {DbQueryGraph} from './db-query.graph';
import {DbQueryAIExtensionBindings} from './keys';
import {
  CheckCacheNode,
  CheckPermissionsNode,
  ClassifyChangeNode,
  FixQueryNode,
  CheckTemplatesNode,
  GenerateChecklistNode,
  GenerateDescriptionNode,
  FailedNode,
  GetColumnsNode,
  GetTablesNode,
  IsImprovementNode,
  SaveDataSetNode,
  SemanticValidatorNode,
  SqlGenerationNode,
  SyntacticValidatorNode,
  VerifyChecklistNode,
} from './nodes';
import {TableSeedObserver} from './observers';
import {DatasetRetriever, TemplateRetriever} from './providers';
import {DataSetHelper, DbSchemaHelperService, TemplateHelper} from './services';
import {PermissionHelper} from './services/permission-helper.service';
import {SchemaStore} from './services/schema.store';
import {TableSearchService} from './services/search/table-search.service';
import {
  AskAboutDatasetTool,
  GetDataAsDatasetTool,
  ImproveDatasetTool,
} from './tools';
import {PgWithRlsConnector} from './connectors/pg';

export class DbQueryComponent implements Component {
  services: ServiceOrProviderClass[] | undefined;
  controllers: ControllerClass[] | undefined;
  components: Constructor<Component>[] | undefined;
  providers: ProviderMap | undefined;
  bindings: Binding<AnyObject>[] | undefined;
  lifeCycleObservers: Constructor<LifeCycleObserver>[] | undefined;
  constructor() {
    this.controllers = [DataSetController, TemplateController];
    this.providers = {
      [DbQueryAIExtensionBindings.QueryCache.key]: DatasetRetriever,
      [DbQueryAIExtensionBindings.TemplateCache.key]: TemplateRetriever,
    };
    this.bindings = [
      createBindingFromClass(PgWithRlsConnector, {
        key: DbQueryAIExtensionBindings.Connector.key,
        defaultScope: BindingScope.TRANSIENT,
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
      TemplateHelper,
      // graph
      DbQueryGraph,
      // tools
      AskAboutDatasetTool,
      GetDataAsDatasetTool,
      ImproveDatasetTool,
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
      ClassifyChangeNode,
      FixQueryNode,
      GenerateChecklistNode,
      GenerateDescriptionNode,
      VerifyChecklistNode,
      GetColumnsNode,
      CheckTemplatesNode,
    ];
    this.components = [DatasetServiceComponent];
  }
}

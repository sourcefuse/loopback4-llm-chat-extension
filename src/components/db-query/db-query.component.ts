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
import {DbQueryAIExtensionBindings} from './keys';
import {TableSeedObserver} from './observers';
import {DatasetRetriever, TemplateRetriever} from './providers';
import {
  DataSetHelper,
  DbSchemaHelperService,
  SemanticCacheService,
  TemplateHelper,
} from './services';
import {ChecklistHelper} from './services/checklist-helper.service';
import {PermissionHelper} from './services/permission-helper.service';
import {SchemaStore} from './services/schema.store';
import {SqlGenerationHelper} from './services/sql-generation.service';
import {SqlValidatorService} from './services/sql-validator.service';
import {TableSearchService} from './services/search/table-search.service';
import {PgWithRlsConnector} from './connectors/pg';
import {
  CheckCacheNode,
  CheckTemplatesNode,
  FailedNode,
  FixQueryNode,
  GenerateChecklistNode,
  GetColumnsNode,
  GetTablesNode,
  ImproveFailedNode,
  LoadExistingNode,
  PostCacheAndTablesNode,
  ReturnCachedNode,
  SaveDataSetNode,
  SaveDatasetFromTemplateNode,
  SaveImprovedNode,
  SqlAndValidateNode,
  VerifyChecklistNode,
} from './nodes';
import {
  AskAboutDatasetTool,
  GetDataAsDatasetTool,
  ImproveDatasetTool,
} from './tools';

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
      // db helpers — still consumed by generateQueryWorkflow / improveQueryWorkflow
      // node bodies.
      ChecklistHelper,
      DbSchemaHelperService,
      PermissionHelper,
      DataSetHelper,
      SchemaStore,
      SemanticCacheService,
      SqlGenerationHelper,
      SqlValidatorService,
      TableSearchService,
      TemplateHelper,
      // db-query tools — registered here (not in the root component) so mounting
      // DbQueryComponent brings its own tools and each is independently
      // selectable/overridable. Discovered by tag (@graphTool).
      GetDataAsDatasetTool,
      ImproveDatasetTool,
      AskAboutDatasetTool,
      // workflow nodes — registered as tagged services exactly as in the
      // LangGraph version; each `@graphNode(key)` class is discovered by tag and
      // resolved per request (WorkflowRunner.resolveGraphNode = BaseGraph._getNodeFn).
      CheckCacheNode,
      CheckTemplatesNode,
      FailedNode,
      FixQueryNode,
      GenerateChecklistNode,
      GetColumnsNode,
      GetTablesNode,
      ImproveFailedNode,
      LoadExistingNode,
      PostCacheAndTablesNode,
      ReturnCachedNode,
      SaveDataSetNode,
      SaveDatasetFromTemplateNode,
      SaveImprovedNode,
      SqlAndValidateNode,
      VerifyChecklistNode,
    ];
    this.components = [DatasetServiceComponent];
  }
}

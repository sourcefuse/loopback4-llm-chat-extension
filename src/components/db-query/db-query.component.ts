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
import {STEP_DEFAULT} from '../../constant';
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
import {PermissionHelper} from './services/permission-helper.service';
import {SchemaStore} from './services/schema.store';
import {TableSearchService} from './services/search/table-search.service';
import {PgWithRlsConnector} from './connectors/pg';
import {DB_QUERY_STEP_CLASSES} from './steps';
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
      // DI-backed workflow steps — bound as tagged services (the `@step(key)`
      // tag makes them discoverable) and marked STEP_DEFAULT so a host override
      // (a second `@step(key)` binding) is preferred by the resolver.
      ...DB_QUERY_STEP_CLASSES.map(stepClass =>
        createBindingFromClass(stepClass).tag({[STEP_DEFAULT]: true}),
      ),
    ];
    this.lifeCycleObservers = [TableSeedObserver];
    this.services = [
      // db helpers — still consumed by generateQueryWorkflow / improveQueryWorkflow
      // step bodies.
      DbSchemaHelperService,
      PermissionHelper,
      DataSetHelper,
      SchemaStore,
      SemanticCacheService,
      TableSearchService,
      TemplateHelper,
      // db-query tools — registered here (not in the root component) so mounting
      // DbQueryComponent brings its own tools and each is independently
      // selectable/overridable. Discovered by tag (@graphTool).
      GetDataAsDatasetTool,
      ImproveDatasetTool,
      AskAboutDatasetTool,
    ];
    this.components = [DatasetServiceComponent];
  }
}

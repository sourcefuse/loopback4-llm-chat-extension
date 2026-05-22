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
import {DataSetHelper, DbSchemaHelperService, TemplateHelper} from './services';
import {PermissionHelper} from './services/permission-helper.service';
import {SchemaStore} from './services/schema.store';
import {TableSearchService} from './services/search/table-search.service';
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
      // db helpers — still consumed by generateQueryWorkflow / improveQueryWorkflow
      // step bodies (Section 16A.4 explicitly preserves these).
      DbSchemaHelperService,
      PermissionHelper,
      DataSetHelper,
      SchemaStore,
      TableSearchService,
      TemplateHelper,
    ];
    this.components = [DatasetServiceComponent];
  }
}

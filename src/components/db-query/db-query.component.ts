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
import {DataSetHelper, DbSchemaHelperService, TemplateHelper} from './services';
import {PermissionHelper} from './services/permission-helper.service';
import {SchemaStore} from './services/schema.store';
import {TableSearchService} from './services/search/table-search.service';
import {GetDataAsDatasetTool, ImproveDatasetTool} from './tools';
import {PgWithRlsConnector} from './connectors/pg';
import {MastraDbQueryWorkflow} from '../../mastra/db-query';
import {
  DatasetSearchService,
  MastraTemplateHelperService,
  TemplateSearchService,
} from '../../mastra/db-query/services';

export class DbQueryComponent implements Component {
  services: ServiceOrProviderClass[] | undefined;
  controllers: ControllerClass[] | undefined;
  components: Constructor<Component>[] | undefined;
  providers: ProviderMap | undefined;
  bindings: Binding<AnyObject>[] | undefined;
  lifeCycleObservers: Constructor<LifeCycleObserver>[] | undefined;
  constructor() {
    this.controllers = [DataSetController, TemplateController];
    this.providers = {};
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
      // Mastra workflow (Phase 3: AI SDK-based nodes, no LangChain)
      MastraDbQueryWorkflow,
      // Mastra search services (replace LangChain BaseRetriever pattern)
      DatasetSearchService,
      TemplateSearchService,
      MastraTemplateHelperService,
      // tools
      GetDataAsDatasetTool,
      ImproveDatasetTool,
    ];
    this.components = [DatasetServiceComponent];
  }
}

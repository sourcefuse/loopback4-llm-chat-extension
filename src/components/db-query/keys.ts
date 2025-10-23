import {BindingKey} from '@loopback/context';
import {
  DatasetServiceConfig,
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
} from './types';
import {AnyObject} from '@loopback/repository';

export namespace DbQueryAIExtensionBindings {
  export const DatasetStore = BindingKey.create<IDataSetStore>(
    'services.ai-integration.db-query.dataset-store',
  );

  export const GlobalContext = BindingKey.create<string[]>(
    'services.ai-integration.db-query.globalcontext',
  );

  export const Config = BindingKey.create<DbQueryConfig>(
    `services.ai-integration.db-query.config`,
  );

  export const QueryCache = BindingKey.create<string>(
    'services.ai-integration.db-query.query-cache',
  );

  export const Connector = BindingKey.create<IDbConnector>(
    'services.ai-integration.db-query.connector',
  );

  export const DbKnowledgeGraph = BindingKey.create<string>(
    'services.ai-integration.db-query.db-knowledge-graph',
  );

  export const DefaultConditions = BindingKey.create<AnyObject>(
    'services.ai-integration.db-query.default-conditions',
  );
}

export namespace DatasetServiceBindings {
  export const Config = BindingKey.create<DatasetServiceConfig>(
    'services.ai-integration.dataset.service.config',
  );
}

export const POST_DATASET_TAG = `ai-integration.post-dataset-generation.node`;

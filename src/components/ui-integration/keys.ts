import {BindingKey} from '@loopback/context';
import {
  DatabaseEnrichmentFn,
  IApiEnrichmentFn,
  UIIntegrationConfig,
} from './types';
import {DatabaseEnrichmentProvider, ApiEnrichmentProvider} from './providers';

export namespace UIIntegrationBindings {
  export const Config = BindingKey.create<UIIntegrationConfig>(
    'services.ai-integration.ui-integration.config',
  );

  export const FormStore = BindingKey.create<string>('form-store');

  export const DatabaseEnrichmentProvider =
    BindingKey.create<DatabaseEnrichmentFn>('database-enrichment-provider');

  export const ApiEnrichmentProvider = BindingKey.create<IApiEnrichmentFn>(
    'api-enrichment-provider',
  );
}

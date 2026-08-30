import {
  Component,
  Constructor,
  ControllerClass,
  ProviderMap,
  ServiceOrProviderClass,
} from '@loopback/core';
import {FormFillingGraph} from './graph';
import {
  EnrichFieldsNode,
  FailedUINode,
  ExtractInfoNode,
  IdentifyFormNode,
  MissingFieldsNode,
  ValidateFieldsNode,
} from './nodes';
import {UIIntegrationBindings} from './keys';
import {FormRegistryService, FormStore} from './form-registry.service';
import {FillFormTool, GetFormSchemaTool, ListFormsTool} from './tools';
import {
  DatabaseEnrichmentProvider,
  ApiEnrichmentProvider,
} from './providers';

export class UIIntegrationComponent implements Component {
  services: ServiceOrProviderClass[] | undefined;
  controllers?: ControllerClass[];
  providers?: ProviderMap;

  constructor() {
    this.services = [
      // Services
      FormRegistryService,
      FormStore,

      // Graph
      FormFillingGraph,

      // Tools
      FillFormTool,
      ListFormsTool,
      GetFormSchemaTool,

      // Nodes
      IdentifyFormNode,
      ExtractInfoNode,
      ValidateFieldsNode,
      EnrichFieldsNode,
      MissingFieldsNode,
      FailedUINode,
    ];

    // Bind default enrichment providers
    // Users can override these by providing their own implementations
    this.providers = {
      [UIIntegrationBindings.DatabaseEnrichmentProvider.key]:
        DatabaseEnrichmentProvider,
      [UIIntegrationBindings.ApiEnrichmentProvider.key]: ApiEnrichmentProvider,
    };
  }
}

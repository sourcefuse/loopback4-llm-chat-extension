import {Component, ProviderMap} from '@loopback/core';
import {AiIntegrationBindings} from '../../../keys';
import {LangsmithObfProvider} from './langsmith.provider';

export class LangsmithComponent implements Component {
  providers: ProviderMap | undefined;
  constructor() {
    this.providers = {
      [AiIntegrationBindings.ObfHandler.key]: LangsmithObfProvider,
    };
  }
}

import {Component, ProviderMap} from '@loopback/core';
import {AiIntegrationBindings} from '../../../keys';
import {LangfuseObfProvider} from './langfuse.provider';

export class LangfuseComponent implements Component {
  providers?: ProviderMap | undefined;
  constructor() {
    this.providers = {
      [AiIntegrationBindings.ObfHandler.key]: LangfuseObfProvider,
    };
  }
}

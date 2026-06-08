import {Component, ProviderMap} from '@loopback/core';
import {InternalBindings} from '../../../mastra/internal-bindings';
import {LangfuseObfProvider} from './langfuse.provider';

export class LangfuseComponent implements Component {
  providers?: ProviderMap | undefined;

  constructor() {
    this.providers = {
      [InternalBindings.Observability.key]: LangfuseObfProvider,
    };
  }
}

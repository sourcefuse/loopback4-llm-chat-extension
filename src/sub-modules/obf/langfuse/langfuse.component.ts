import {Component, ProviderMap} from '@loopback/core';
import {MastraInternalBindings} from '../../../mastra/internal-bindings';
import {LangfuseObfProvider} from './langfuse.provider';

export class LangfuseComponent implements Component {
  providers?: ProviderMap | undefined;

  constructor() {
    this.providers = {
      [MastraInternalBindings.Observability.key]: LangfuseObfProvider,
    };
  }
}

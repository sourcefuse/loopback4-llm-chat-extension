import {inject, Provider, ValueOrPromise} from '@loopback/core';
import {AiIntegrationBindings} from '../../keys';
import {EmbeddingProvider} from '../../types';
import {MemoryVectorStore} from '../../vector';

export class InMemoryVectorStore implements Provider<MemoryVectorStore> {
  constructor(
    @inject(AiIntegrationBindings.EmbeddingModel)
    private readonly embeddings: EmbeddingProvider,
  ) {}
  value(): ValueOrPromise<MemoryVectorStore> {
    return new MemoryVectorStore(this.embeddings);
  }
}

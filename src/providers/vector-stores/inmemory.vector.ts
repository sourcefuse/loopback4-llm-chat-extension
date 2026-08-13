import {inject, Provider, service, ValueOrPromise} from '@loopback/core';
import {AiIntegrationBindings} from '../../keys';
import {EmbeddingService} from '../../services/embedding.service';
import {EmbeddingProvider} from '../../types';
import {MemoryVectorStore} from '../../vector';

export class InMemoryVectorStore implements Provider<MemoryVectorStore> {
  constructor(
    @service(EmbeddingService)
    private readonly embedder: EmbeddingService,
    @inject(AiIntegrationBindings.EmbeddingModel)
    private readonly embeddings: EmbeddingProvider,
  ) {}
  value(): ValueOrPromise<MemoryVectorStore> {
    return new MemoryVectorStore(this.embedder, this.embeddings);
  }
}

import {inject, Provider, ValueOrPromise} from '@loopback/core';
import {MemoryVectorStore} from 'langchain/vectorstores/memory';
import {AiIntegrationBindings} from '../../keys';
import {EmbeddingProvider} from '../../types';
export class InMemoryVectorStore implements Provider<MemoryVectorStore> {
  constructor(
    @inject(AiIntegrationBindings.EmbeddingModel)
    private readonly embeddings: EmbeddingProvider,
  ) {}
  value(): ValueOrPromise<MemoryVectorStore> {
    return new MemoryVectorStore(this.embeddings);
  }
}

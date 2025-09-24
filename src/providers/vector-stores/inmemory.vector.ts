import {inject, Provider, ValueOrPromise} from '@loopback/core';
import {MemoryVectorStore} from 'langchain/vectorstores/memory';
import {AiIntegrationBindings} from '../../keys';
import {EmbeddingProvider} from '../../types';
import {AnyObject} from '@loopback/repository';
export class InMemoryVectorStore implements Provider<MemoryVectorStore> {
  constructor(
    @inject(AiIntegrationBindings.EmbeddingModel)
    private readonly embeddings: EmbeddingProvider,
  ) {}
  value(): ValueOrPromise<MemoryVectorStore> {
    const memory = new MemoryVectorStore(this.embeddings);
    memory.delete = async (params: AnyObject) => {};
    return memory;
  }
}

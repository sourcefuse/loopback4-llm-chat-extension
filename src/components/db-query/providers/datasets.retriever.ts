import {BaseRetriever} from '@langchain/core/retrievers';
import {VectorStore} from '@langchain/core/vectorstores';
import {inject, Provider, ValueOrPromise} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {MemoryVectorStore} from 'langchain/vectorstores/memory';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryStoredTypes} from '../types';

export class DatasetRetriever implements Provider<BaseRetriever> {
  constructor(
    @inject(AiIntegrationBindings.VectorStore)
    private readonly vectorStore: VectorStore,
  ) {}
  value(): ValueOrPromise<BaseRetriever<AnyObject>> {
    if (this.vectorStore instanceof MemoryVectorStore) {
      return this.vectorStore.asRetriever({
        k: 5,
        filter: doc => doc.metadata.type === DbQueryStoredTypes.DataSet,
        searchType: 'similarity',
      });
    }
    return this.vectorStore.asRetriever({
      k: 5,
      filter: {
        type: DbQueryStoredTypes.DataSet,
      },
      searchType: 'similarity',
    });
  }
}

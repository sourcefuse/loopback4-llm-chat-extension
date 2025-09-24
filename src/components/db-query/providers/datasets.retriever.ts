import {BaseRetriever} from '@langchain/core/retrievers';
import {VectorStore} from '@langchain/core/vectorstores';
import {inject, Provider, ValueOrPromise} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {MemoryVectorStore} from 'langchain/vectorstores/memory';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryStoredTypes} from '../types';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from '@sourceloop/core';

export class DatasetRetriever implements Provider<BaseRetriever> {
  constructor(
    @inject(AiIntegrationBindings.VectorStore)
    private readonly vectorStore: VectorStore,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
  ) {}
  value(): ValueOrPromise<BaseRetriever<AnyObject>> {
    if (this.vectorStore instanceof MemoryVectorStore) {
      return this.vectorStore.asRetriever({
        k: 20,
        filter: doc =>
          doc.metadata.type === DbQueryStoredTypes.DataSet &&
          doc.metadata.tenantId === this.user.tenantId,
        searchType: 'similarity',
      });
    }
    return this.vectorStore.asRetriever({
      k: 5,
      filter: {
        type: DbQueryStoredTypes.DataSet,
        tenantId: this.user.tenantId,
      },
      searchType: 'similarity',
    });
  }
}

import {Document} from '@langchain/core/documents';
import {BaseRetriever} from '@langchain/core/retrievers';
import {VectorStore} from '@langchain/core/vectorstores';
import {inject, Provider, ValueOrPromise} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {MemoryVectorStore} from '@langchain/classic/vectorstores/memory';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryStoredTypes} from '../types';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from '@sourceloop/core';

export class TemplateRetriever implements Provider<BaseRetriever> {
  constructor(
    @inject(AiIntegrationBindings.VectorStore)
    private readonly vectorStore: VectorStore,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
  ) {}
  value(): ValueOrPromise<BaseRetriever<AnyObject>> {
    if (this.vectorStore instanceof MemoryVectorStore) {
      return this.vectorStore.asRetriever({
        k: 5,
        filter: (doc: Document) =>
          doc.metadata.type === DbQueryStoredTypes.Template &&
          doc.metadata.tenantId === this.user.tenantId,
        searchType: 'similarity',
      });
    }
    return this.vectorStore.asRetriever({
      k: 5,
      filter: {
        type: DbQueryStoredTypes.Template,
        tenantId: this.user.tenantId,
      },
      searchType: 'similarity',
    });
  }
}

import {inject, Provider, ValueOrPromise} from '@loopback/core';
import {BaseRetriever, VectorStore} from '../../../vector';
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
  value(): ValueOrPromise<BaseRetriever> {
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

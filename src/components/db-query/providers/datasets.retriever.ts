import {Provider, ValueOrPromise, inject} from '@loopback/core';
import {
  DbQueryStoredTypes,
  ISemanticCacheRetriever,
  QueryCacheMetadata,
} from '../types';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {SemanticCacheService} from '../services';

export class DatasetRetriever implements Provider<
  ISemanticCacheRetriever<QueryCacheMetadata>
> {
  constructor(
    @inject('services.SemanticCacheService')
    private readonly semanticCache: SemanticCacheService,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
  ) {}

  value(): ValueOrPromise<ISemanticCacheRetriever<QueryCacheMetadata>> {
    return {
      invoke: async query => {
        const tenantId = this.user.tenantId;
        if (!tenantId) return [];
        const docs = await this.semanticCache.search<QueryCacheMetadata>(
          query,
          {
            type: DbQueryStoredTypes.DataSet,
            tenantId,
            topK: 5,
          },
        );

        const out: Array<{
          pageContent: string;
          metadata: QueryCacheMetadata;
        }> = [];
        for (const doc of docs) {
          const datasetId =
            (doc.metadata.datasetId as string | undefined) ??
            (doc.metadata.id as string | undefined);
          if (!datasetId) continue;
          out.push({
            pageContent: doc.pageContent,
            metadata: {
              ...doc.metadata,
              datasetId,
              id: datasetId,
            },
          });
        }
        return out;
      },
    };
  }
}

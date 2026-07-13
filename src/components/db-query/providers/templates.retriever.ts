import {Provider, ValueOrPromise, inject} from '@loopback/core';
import {
  DbQueryStoredTypes,
  ISemanticCacheRetriever,
  QueryTemplateMetadata,
} from '../types';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {SemanticCacheService} from '../services';

export class TemplateRetriever implements Provider<
  ISemanticCacheRetriever<QueryTemplateMetadata>
> {
  constructor(
    @inject('services.SemanticCacheService')
    private readonly semanticCache: SemanticCacheService,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
  ) {}

  value(): ValueOrPromise<ISemanticCacheRetriever<QueryTemplateMetadata>> {
    return {
      invoke: async query => {
        const tenantId = this.user.tenantId;
        if (!tenantId) return [];
        const docs = await this.semanticCache.search<QueryTemplateMetadata>(
          query,
          {
            type: DbQueryStoredTypes.Template,
            tenantId,
            topK: 5,
          },
        );

        const out: Array<{
          pageContent: string;
          metadata: QueryTemplateMetadata;
        }> = [];
        for (const doc of docs) {
          const templateId =
            (doc.metadata.templateId as string | undefined) ??
            (doc.metadata.id as string | undefined);
          if (!templateId) continue;
          out.push({
            pageContent: doc.pageContent,
            metadata: {
              ...doc.metadata,
              templateId,
              id: templateId,
            },
          });
        }
        return out;
      },
    };
  }
}

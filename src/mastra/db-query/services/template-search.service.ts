import {inject, injectable, BindingScope} from '@loopback/core';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {AiIntegrationBindings} from '../../../keys';
import {
  DbQueryStoredTypes,
  QueryTemplateMetadata,
} from '../../../components/db-query/types';
import {IVectorStore, IVectorStoreDocument} from '../../../types';

const debug = require('debug')(
  'ai-integration:mastra:db-query:template-search',
);

/**
 * Mastra-path replacement for the LangChain `TemplateRetriever` provider.
 *
 * Injects `AiIntegrationBindings.AiSdkVectorStore` (`IVectorStore`) instead of
 * the LangChain `VectorStore`, eliminating all `@langchain/core` dependencies
 * from the Mastra execution path.  The returned document shape mirrors
 * `DocumentInterface` (`pageContent` + `metadata`) so existing step callers
 * need no changes.
 */
@injectable({scope: BindingScope.REQUEST})
export class TemplateSearchService {
  constructor(
    @inject(AiIntegrationBindings.AiSdkVectorStore)
    private readonly vectorStore: IVectorStore,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
  ) {}

  /**
   * Performs a similarity search against the stored query-template vector index.
   *
   * @param query - The natural-language query to match against template descriptions.
   * @param k     - Number of results to return (default: 5).
   * @returns Matching template documents ordered by descending relevance.
   */
  async search(
    query: string,
    k = 5,
  ): Promise<IVectorStoreDocument<QueryTemplateMetadata>[]> {
    const tenantId = this.user.tenantId;
    debug('search start', {query: query.slice(0, 80), k, tenantId});
    if (!tenantId) {
      debug('no tenantId — returning empty results');
      return [];
    }
    const results =
      await this.vectorStore.similaritySearch<QueryTemplateMetadata>(query, k, {
        type: DbQueryStoredTypes.Template,
        tenantId,
      });
    debug('search complete: %d results', results.length);
    return results;
  }
}

import {DocumentInterface} from '@langchain/core/documents';
import {PromptTemplate} from '@langchain/core/prompts';
import {BaseRetriever} from '@langchain/core/retrievers';
import {RunnableSequence} from '@langchain/core/runnables';
import {inject, service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {
  IGraphNode,
  LLMStreamEventType,
  RunnableConfig,
  ToolStatus,
} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DataSetHelper} from '../services';
import {DbQueryState} from '../state';
import {CacheResults, QueryCacheMetadata} from '../types';

@graphNode(DbQueryNodes.CheckCache)
export class CheckCacheNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(DbQueryAIExtensionBindings.QueryCache)
    private readonly cache: BaseRetriever<QueryCacheMetadata>,
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly smartLLM: LLMProvider,
    @service(DataSetHelper)
    private readonly dataSetHelper: DataSetHelper,
  ) {}
  prompt = PromptTemplate.fromTemplate(`
    You are expect SQL analyser, you will be given a prompt and a list of queries, and you need to return the most relevant query from the list and in which of the following ways is it relevant - 
    - return '${CacheResults.AsIs}' if the query exactly answers the question in the prompt.
    - return '${CacheResults.Similar}' if the query is similar to the question in the prompt but not exactly the same.
    - return '${CacheResults.NotRelevant}' if the query is not relevant to the prompt at all.

    Remember that if the cached query has extra information, then still the query could be considered exactly same as long as it does not contradict the prompt.

    This is the user prompt: {prompt}
    This is the list of queries:
    {queries}

    Your output should just be one of the 3 things - '${CacheResults.AsIs}', '${CacheResults.Similar}', '${CacheResults.NotRelevant}' and the index (where 0 would be index of first query) of the most relevant query in following format -
    
    <relevance> <query index>
    Do not return any other text or explanation, just the output in the above format.
    If no queries are relevant, return 'no-relevant-queries' and nothing else.
    `);
  async execute(
    state: DbQueryState,
    config: RunnableConfig,
  ): Promise<DbQueryState> {
    if (state.sampleSql) {
      return state;
    }
    const relevantDocs = await this.cache.invoke(state.prompt, config);
    if (relevantDocs.length === 0) {
      return state;
    }
    const chain = RunnableSequence.from([
      this.prompt,
      this.smartLLM,
      stripThinkingTokens,
    ]);

    const response = await chain.invoke(
      {
        queries: relevantDocs
          .map((doc, index) => `${index + 1}. ${doc.pageContent}`)
          .join('\n'),
        prompt: state.prompt,
      },
      config,
    );

    const [relevance, index] = response.split(' ');
    const indexNum = parseInt(index, 10);
    if (indexNum > relevantDocs.length || indexNum < 0 || isNaN(indexNum)) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Index ${index} is out of bounds for the list of relevant queries.
          Available queries: ${this._buildCacheLog(relevantDocs)}`,
      });
      return state;
    }
    if (relevance === CacheResults.NotRelevant) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `No relevant queries found in cache for this prompt`,
      });
      return state;
    }
    if (relevance === CacheResults.AsIs) {
      const missingPermissions = await this.dataSetHelper.checkPermissions(
        relevantDocs[indexNum].metadata.datasetId,
      );
      if (missingPermissions.length > 0) {
        config.writer?.({
          type: LLMStreamEventType.Log,
          data: `Found relevant query in cache, but missing permissions: ${missingPermissions.join(
            ', ',
          )} so generating new query`,
        });
        return state;
      }
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Found relevant query in cache, using it as is`,
      });
      config.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {
          status: `Found relevant query in cache`,
        },
      });
      const datasetId = relevantDocs[indexNum].metadata.datasetId;
      config.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {
          status: ToolStatus.Completed,
          data: {
            datasetId,
          },
        },
      });
      return {
        ...state,
        fromCache: true,
        datasetId,
        replyToUser: `I found this dataset in the cache - ${relevantDocs[indexNum].pageContent}`,
      };
    }
    if (relevance === CacheResults.Similar) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Found similar query in cache, using it as example`,
      });
      config.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {
          status: `Found similar query in cache, using it as example`,
        },
      });
      config.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {
          status: `Found relevant query in cache`,
        },
      });
      return {
        ...state,
        sampleSql: relevantDocs[indexNum].metadata.query,
        sampleSqlPrompt: relevantDocs[indexNum].pageContent,
      };
    }
    return state;
  }

  private _buildCacheLog(
    relevantDocs: DocumentInterface<QueryCacheMetadata>[],
  ) {
    return relevantDocs
      .map((doc, i) => `${i + 1}. ${doc.pageContent}`)
      .join('\n');
  }
}

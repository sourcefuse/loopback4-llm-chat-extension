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
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly smartLLM: LLMProvider,
    @service(DataSetHelper)
    private readonly dataSetHelper: DataSetHelper,
  ) {}
  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are an expert Semantic analyser, you will be given a prompt and a list of past prompts that were successfully processed, and you need to return the most relevant prompt from the list and in which of the following ways is it relevant - 
- return '${CacheResults.AsIs}' if the prompt's result would contain the information the user is looking for without any changes in the result, and can be used as it is.
- return '${CacheResults.Similar}' if the prompt's result would be similar to the question in the new prompt but not exactly, and can be modified to get the data user needs.
- return '${CacheResults.NotRelevant}' if the prompt is not relevant to the new prompt at all.
Remember that if the cached prompt has extra information, then still the old prompt could be considered exactly same as long as it does not contradict the new prompt.
</instructions>
<user-question>
{prompt}
</user-question>
<queries>
{queries}
</queries>
<output-format>
format -
relevant index-of-query-starting-from-1
examples - 
${CacheResults.AsIs} 2

${CacheResults.Similar} 1

${CacheResults.NotRelevant}

</output-format>
<output-instructions>
Do not return any other text or explanation, just the output in the above format.
If no queries are relevant, return '${CacheResults.NotRelevant}' and nothing else.
</output-instructions>`);
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
          .map(
            (doc, index) =>
              `<query-${index + 1}>\n${doc.pageContent}\n</query-${index + 1}>`,
          )
          .join('\n'),
        prompt: state.prompt,
      },
      config,
    );

    const [relevance, index] = response.split(' ');
    const indexNum = parseInt(index, 10) - 1; // Convert to 0-based index
    if (relevance === CacheResults.NotRelevant) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `No relevant queries found in cache for this prompt`,
      });
      return state;
    }
    if (indexNum >= relevantDocs.length || indexNum < 0 || isNaN(indexNum)) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Index ${index} is out of bounds for the list of relevant queries.
          Available queries: ${this._buildCacheLog(relevantDocs)}`,
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

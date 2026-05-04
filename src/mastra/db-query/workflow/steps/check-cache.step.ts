import {generateText} from 'ai';
import {DataSetHelper} from '../../../../components/db-query/services';
import {DatasetActionType} from '../../../../components/db-query/constant';
import {DbQueryState} from '../../../../components/db-query/state';
import {CacheResults} from '../../../../components/db-query/types';
import {LLMStreamEventType, ToolStatus} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {DatasetSearchService} from '../../services/dataset-search.service';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')('ai-integration:mastra:db-query:check-cache');

const CACHE_PROMPT = `
<instructions>
You are an expert Semantic analyser, you will be given a prompt from the user and a list of past prompts that were handled successfully, along with description of the sql generated from those prompts.
You need to return the most relevant prompt from the list and in which of the following ways is it relevant -
- return '${CacheResults.AsIs}' if the prompt's result would contain the information the user is looking for without any changes in the result, and can be used as it is.
- return '${CacheResults.Similar}' if the prompt's result would be similar to the question in the new prompt but not exactly, and can be modified to get the data user needs.
- return '${CacheResults.NotRelevant}' if the prompt is not relevant to the new prompt at all.
Remember that if the cached prompt has extra information, then still the old prompt could be considered exactly same as long as it does not contradict the new prompt.
</instructions>
<user-prompt>
{prompt}
</user-prompt>
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
</output-instructions>`;

export type CheckCacheStepDeps = {
  datasetSearch: DatasetSearchService;
  llm: LLMProvider;
  dataSetHelper: DataSetHelper;
};

/**
 * Searches the dataset vector index for semantically similar past queries and
 * uses the LLM to classify the relevance.
 */
export async function checkCacheStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: CheckCacheStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {prompt: state.prompt, hasSampleSql: !!state.sampleSql});

  if (state.sampleSql) {
    debug('sampleSql already set — skipping cache check');
    return {};
  }

  const relevantDocs = await deps.datasetSearch.search(state.prompt);
  if (relevantDocs.length === 0) {
    debug('no documents in cache for prompt');
    return {};
  }

  const queriesText = relevantDocs
    .map(
      (doc, index) =>
        `<query-${index + 1}>\n<prompt>\n${doc.pageContent}\n</prompt>\n<description>${doc.metadata.description}</description></query-${index + 1}>`,
    )
    .join('\n');

  const content = buildPrompt(CACHE_PROMPT, {
    prompt: state.prompt,
    queries: queriesText,
  });

  debug('invoking LLM for cache relevance classification');
  const {text, usage} = await generateText({
    model: deps.llm,
    messages: [{role: 'user', content}],
  });
  context.onUsage?.(usage.inputTokens ?? 0, usage.outputTokens ?? 0, 'unknown');
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });

  const response = stripThinkingFromText(text);
  const [relevance, index] = response.split(' ');
  const indexNum = parseInt(index, 10) - 1;

  if (relevance === CacheResults.NotRelevant) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: 'No relevant queries found in cache for this prompt',
    });
    return {};
  }

  if (indexNum >= relevantDocs.length || indexNum < 0 || isNaN(indexNum)) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `Index ${index} is out of bounds for the list of relevant queries.`,
    });
    return {};
  }

  if (relevance === CacheResults.AsIs) {
    const missingPermissions = await deps.dataSetHelper.checkPermissions(
      relevantDocs[indexNum].metadata.datasetId,
    );
    if (missingPermissions.length > 0) {
      context.writer?.({
        type: LLMStreamEventType.Log,
        data: `Found relevant query in cache, but missing permissions: ${missingPermissions.join(', ')} so generating new query`,
      });
      return {};
    }

    const [dataset] = await deps.dataSetHelper.find({
      where: {id: relevantDocs[indexNum].metadata.datasetId},
      include: [{relation: 'actions'}],
    });

    if (
      !dataset ||
      (dataset.actions?.length &&
        dataset.actions?.some(a => a.action === DatasetActionType.Disliked))
    ) {
      context.writer?.({
        type: LLMStreamEventType.Log,
        data: 'Found relevant query in cache, but the dataset was not found or was disliked by the user, so generating new query',
      });
      return {};
    }

    const datasetId = relevantDocs[indexNum].metadata.datasetId;
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Found relevant query in cache, using it as is',
    });
    context.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Found relevant query in cache'},
    });

    if (!state.directCall) {
      context.writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {
          status: ToolStatus.Completed,
          data: {datasetId},
        },
      });
    }

    const result = {
      fromCache: true,
      datasetId,
      replyToUser: `I found this dataset in the cache - ${relevantDocs[indexNum].pageContent}`,
    };
    debug('step result (AsIs cache hit)', result);
    return result;
  }

  if (relevance === CacheResults.Similar) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Found similar query in cache, using it as example',
    });
    context.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Found similar query in cache, using it as example'},
    });
    context.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Found relevant query in cache'},
    });

    const result = {
      sampleSql: relevantDocs[indexNum].metadata.query,
      sampleSqlPrompt: relevantDocs[indexNum].pageContent,
    };
    debug('step result (Similar cache hit)', result);
    return result;
  }

  return {};
}

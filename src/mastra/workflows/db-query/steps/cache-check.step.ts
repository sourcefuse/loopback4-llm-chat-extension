import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {DatasetActionType} from '../../../../components/db-query/constant';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';

const CACHE_CHECK_PROMPT = `
<instructions>
You are an expert Semantic analyser, you will be given a prompt from the user and a list of past prompts that were handled successfully, along with description of the sql generated from those prompts.
You need to return the most relevant prompt from the list and in which of the following ways is it relevant -
- return 'as-is' if the prompt's result would contain the information the user is looking for without any changes in the result, and can be used as it is.
- return 'similar' if the prompt's result would be similar to the question in the new prompt but not exactly, and can be modified to get the data user needs.
- return 'not-relevant' if the prompt is not relevant to the new prompt at all.
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
as-is 2

similar 1

not-relevant

</output-format>
<output-instructions>
Do not return any other text or explanation, just the output in the above format.
If no queries are relevant, return 'not-relevant' and nothing else.
</output-instructions>`;

/**
 * CacheCheckStep — replaces CheckCacheNode.
 *
 * Searches the query cache for semantically similar past queries.
 * If an exact match is found (as-is), returns it directly.
 * If a similar query is found, provides it as a sample for SQL generation.
 */
export const cacheCheckStep = createStep({
  id: 'cache-check',
  inputSchema: z.object({
    prompt: z.string(),
    sampleSql: z.string().optional(),
    directCall: z.boolean().optional(),
  }),
  outputSchema: z.object({
    fromCache: z.boolean().optional(),
    datasetId: z.string().optional(),
    replyToUser: z.string().optional(),
    sampleSql: z.string().optional(),
    sampleSqlPrompt: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const queryCache = ctx.get('queryCache');
    const cheapLlm = ctx.get('cheapLlm');
    const datasetHelper = ctx.get('datasetHelper');
    const directCall = inputData.directCall ?? false;

    if (inputData.sampleSql) {
      return {};
    }

    const relevantDocs = await queryCache.invoke(inputData.prompt);
    if (relevantDocs.length === 0) {
      return {};
    }

    const prompt = CACHE_CHECK_PROMPT.replace(
      '{prompt}',
      inputData.prompt,
    ).replace('{queries}', buildQueriesText(relevantDocs));

    const rawResponse = await invokeLlm(cheapLlm, prompt);
    const decision = parseCacheDecision(
      stripThinkingTokens(rawResponse),
      relevantDocs.length,
    );

    if (decision.status === 'not-relevant') {
      await log(writer, 'No relevant queries found in cache for this prompt');
      return {};
    }

    if (decision.status === 'invalid-index') {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: 'Cache returned an invalid result index. Falling back to generation.',
      });
      return {};
    }

    if (decision.status === 'as-is') {
      return handleAsIsDecision({
        decisionIndex: decision.index,
        relevantDocs,
        datasetHelper,
        writer,
        directCall,
      });
    }

    if (decision.status === 'similar') {
      return handleSimilarDecision(decision.index, relevantDocs, writer);
    }

    return {};
  },
});

function buildQueriesText(
  relevantDocs: Array<{
    pageContent: string;
    metadata: {description: string};
  }>,
): string {
  return relevantDocs
    .map(
      (doc, index) =>
        `<query-${index + 1}>\n<prompt>\n${doc.pageContent}\n</prompt>\n<description>${doc.metadata.description}</description></query-${index + 1}>`,
    )
    .join('\n');
}

function parseCacheDecision(
  response: string,
  maxIndex: number,
):
  | {status: 'not-relevant'}
  | {status: 'invalid-index'}
  | {status: 'as-is'; index: number}
  | {status: 'similar'; index: number} {
  const [relevance, indexValue] = response.split(' ');
  if (relevance === 'not-relevant') {
    return {status: 'not-relevant'};
  }

  const index = Number.parseInt(indexValue, 10) - 1;
  if (Number.isNaN(index) || index < 0 || index >= maxIndex) {
    return {status: 'invalid-index'};
  }

  if (relevance === 'as-is') {
    return {status: 'as-is', index};
  }

  return {status: 'similar', index};
}

async function handleAsIsDecision(params: {
  decisionIndex: number;
  relevantDocs: Array<{
    pageContent: string;
    metadata: {datasetId: string};
  }>;
  datasetHelper: {
    checkPermissions(datasetId: string): Promise<string[]>;
    find(filter: {
      where: {id: string};
      include: Array<{relation: string}>;
    }): Promise<Array<{actions?: Array<{action: DatasetActionType}>}>>;
  };
  writer: {
    write: (event: {
      type: LLMStreamEventType;
      data: string | {status: string; data?: {datasetId: string}};
    }) => Promise<void>;
  };
  directCall: boolean;
}): Promise<{} | {fromCache: boolean; datasetId: string; replyToUser: string}> {
  const datasetId =
    params.relevantDocs[params.decisionIndex].metadata.datasetId;
  const missingPermissions =
    await params.datasetHelper.checkPermissions(datasetId);
  if (missingPermissions.length > 0) {
    await log(
      params.writer,
      `Found relevant query in cache, but missing permissions: ${missingPermissions.join(', ')} so generating new query`,
    );
    return {};
  }

  await log(params.writer, 'Found relevant query in cache, using it as is');
  await params.writer.write({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Found relevant query in cache'},
  });

  const [dataset] = await params.datasetHelper.find({
    where: {id: datasetId},
    include: [{relation: 'actions'}],
  });

  const disliked =
    !!dataset?.actions?.length &&
    dataset.actions.some(
      action => action.action === DatasetActionType.Disliked,
    );
  if (!dataset || disliked) {
    await log(
      params.writer,
      'Found relevant query in cache, but the dataset was not found or was disliked by the user, so generating new query',
    );
    return {};
  }

  if (!params.directCall) {
    await params.writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'completed', data: {datasetId}},
    });
  }

  return {
    fromCache: true,
    datasetId,
    replyToUser: `I found this dataset in the cache - ${params.relevantDocs[params.decisionIndex].pageContent}`,
  };
}

async function handleSimilarDecision(
  decisionIndex: number,
  relevantDocs: Array<{
    pageContent: string;
    metadata: {query: string};
  }>,
  writer: {
    write: (event: {
      type: LLMStreamEventType;
      data: string | {status: string};
    }) => Promise<void>;
  },
): Promise<{sampleSql: string; sampleSqlPrompt: string}> {
  await log(writer, 'Found similar query in cache, using it as example');
  await writer.write({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Found similar query in cache, using it as example'},
  });

  return {
    sampleSql: relevantDocs[decisionIndex].metadata.query,
    sampleSqlPrompt: relevantDocs[decisionIndex].pageContent,
  };
}

async function log(
  writer: {
    write: (event: {type: LLMStreamEventType; data: string}) => Promise<void>;
  },
  data: string,
): Promise<void> {
  await writer.write({
    type: LLMStreamEventType.Log,
    data,
  });
}

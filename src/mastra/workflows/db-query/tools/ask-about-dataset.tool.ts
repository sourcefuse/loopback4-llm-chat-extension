import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import type {RequestContext} from '@mastra/core/request-context';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import type {JsonObject, JsonValue} from '../../../../types';

const ASK_ABOUT_DATASET_PROMPT = `You are an AI assistant that answers questions about a query, without revealing any technical details, you need to answer the question the user's question.
Make sure you don't reveal the original query to the user, just answer the question based on the query.
Here is the query that the question was for -
{query}

and here is the schema the query was generated for -
{schema}

and here is the context that was provided for the query - 
{context}

and here is the user's question -
{question}`;

const askAboutDatasetResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  done: z.boolean(),
  datasetId: z.string().optional(),
  replyToUser: z.string(),
});

type AskAboutDatasetToolResult = z.infer<typeof askAboutDatasetResultSchema>;

function toJsonObject(value: JsonValue): JsonObject {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {
    value:
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
        ? value
        : String(value),
  };
}

export const askAboutDatasetTool = createTool({
  id: 'ask-about-dataset',
  description:
    'Tool for answering questions about an existing dataset. It can only answer questions about dataset/query definition and intent, not raw row-level data. Call this only if you have a valid dataset ID.',
  inputSchema: z.object({
    datasetId: z
      .string()
      .describe('UUID ID of the existing dataset to answer a question about'),
    question: z
      .string()
      .describe(
        'The user question about the dataset definition or query intent.',
      ),
  }),
  outputSchema: askAboutDatasetResultSchema,
  execute: async (
    inputData: {datasetId: string; question: string},
    {requestContext}: {requestContext?: RequestContext},
  ): Promise<AskAboutDatasetToolResult> => {
    if (!requestContext) {
      throw new Error(
        'RequestContext is required for ask-about-dataset tool execution.',
      );
    }

    const ctx = asDbQueryContext(requestContext);
    const datasetStore = ctx.get('datasetStore');
    const schemaStore = ctx.get('schemaStore');
    const schemaHelper = ctx.get('schemaHelper');
    const cheapLlm = ctx.get('cheapLlm');
    const globalContext = ctx.get('globalContext');

    try {
      const dataset = await datasetStore.findById(inputData.datasetId);
      const filteredSchema = schemaStore.filteredSchema(dataset.tables);
      const schemaContext = schemaHelper.getTablesContext(filteredSchema);
      const prompt = ASK_ABOUT_DATASET_PROMPT.replace('{query}', dataset.query)
        .replace('{schema}', JSON.stringify(filteredSchema))
        .replace('{context}', [...globalContext, ...schemaContext].join('\n'))
        .replace('{question}', inputData.question);

      const llmResponse = await invokeLlm(cheapLlm, prompt);
      const reply = stripThinkingTokens(llmResponse).trim();

      return {
        status: 'completed',
        done: true,
        datasetId: inputData.datasetId,
        replyToUser: reply || 'I could not derive an answer for this dataset.',
      };
    } catch (error) {
      return {
        status: 'failed',
        done: false,
        datasetId: inputData.datasetId,
        replyToUser:
          error instanceof Error
            ? error.message
            : 'Unable to answer dataset question.',
      };
    }
  },
});

export function formatAskAboutDatasetResult(result: JsonObject): string {
  const parsed = askAboutDatasetResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return JSON.stringify(result);
  }

  return parsed.data.replyToUser;
}

export function getAskAboutDatasetMetadata(result: JsonObject): JsonObject {
  const parsed = askAboutDatasetResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return {status: 'failed'};
  }

  return {
    status: parsed.data.status,
    existingDatasetId: parsed.data.datasetId ?? null,
  };
}

import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import type {RequestContext} from '@mastra/core/request-context';
import {dbQueryWorkflow} from '../db-query.workflow';
import {asDbQueryContext} from '../db-query-request-context';
import {
  dbQueryWorkflowOutputSchema,
  type DbQueryWorkflowOutput,
} from '../db-query-workflow-schemas';
import type {LLMStreamEvent} from '../../../../graphs/event.types';
import type {AsyncEventQueue} from '../../../bridge/async-event-queue';
import type {JsonObject, JsonValue} from '../../../../types';

const DEFAULT_MAX_READ_ROWS_FOR_AI = 25;

const datasetToolResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  done: z.boolean(),
  datasetId: z.string().optional(),
  replyToUser: z.string(),
  resultArray: z.array(z.object({}).passthrough()).optional(),
});

type DatasetToolResult = z.infer<typeof datasetToolResultSchema>;

/**
 * Type guard for LLMStreamEvent extracted from workflow chunks.
 */
function isLLMStreamEvent(
  value: object | null | undefined,
): value is LLMStreamEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'data' in value
  );
}

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

/**
 * Mastra-native tool: get-data-as-dataset
 *
 * Replaces the LangChain `GetDataAsDatasetTool` by running the
 * `dbQueryWorkflow` directly, streaming events to the AsyncEventQueue.
 *
 * Used by the ChatWorkflow Agent when the user requests tabular data.
 */
export const getDataAsDatasetTool = createTool({
  id: 'get-data-as-dataset',
  description: `Query tool for generating SQL queries for a users request. Use it only when the user needs raw tabular data from the database.
Do not use this tool if the user's request involves trends, growth, decline, comparisons, distributions, patterns, or any form of analytical insight — use the 'generate-visualization' tool instead.
Note that it does not return the query, instead only a dataset ID that is not relevant to the user.
It internally fires an event that renders a grid for the dataset on the UI for the user to see.`,
  inputSchema: z.object({
    prompt: z
      .string()
      .describe(
        'Prompt from the user that will be used for generating an SQL query and create a dataset from it.',
      ),
  }),
  outputSchema: datasetToolResultSchema,
  execute: async (
    inputData: {prompt: string},
    {requestContext}: {requestContext?: RequestContext},
  ): Promise<DatasetToolResult> => {
    if (!requestContext) {
      throw new Error(
        'RequestContext is required for get-data-as-dataset tool execution.',
      );
    }

    const ctx = asDbQueryContext(requestContext);
    const eventQueue = requestContext.get('eventQueue') as
      | AsyncEventQueue
      | undefined;
    const schema = ctx.get('fullSchema');
    const abortSignal = ctx.get('abortSignal');

    if (!schema) {
      throw new Error(
        'fullSchema not found in RequestContext. ' +
          'Ensure the DB Query component is properly configured.',
      );
    }

    const run = await dbQueryWorkflow.createRun();
    const stream = run.stream({
      inputData: {prompt: inputData.prompt, schema},
      requestContext,
    });

    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return {
          status: 'failed',
          done: false,
          replyToUser:
            'Request was cancelled before dataset generation finished.',
        };
      }

      if (chunk.type === 'workflow-step-output') {
        const output = chunk.payload?.output;
        if (eventQueue && isLLMStreamEvent(output)) {
          eventQueue.push(output);
        }
      }
    }

    const finalResult = await stream.result;
    if (finalResult.status !== 'success') {
      return {
        status: 'failed',
        done: false,
        replyToUser: 'Unable to generate dataset.',
      };
    }

    const parsedOutput = dbQueryWorkflowOutputSchema.safeParse(
      finalResult.result,
    );
    if (!parsedOutput.success) {
      return {
        status: 'failed',
        done: false,
        replyToUser: 'Unable to parse DBQuery workflow output.',
      };
    }

    return formatResult(parsedOutput.data, ctx.get('dbQueryConfig'));
  },
});

function formatResult(
  result: DbQueryWorkflowOutput,
  config?: {maxRowsForAI?: number},
): DatasetToolResult {
  const status = result.done ? 'completed' : 'failed';

  if (!result.done || !result.datasetId) {
    return {
      status,
      done: false,
      replyToUser: result.replyToUser ?? 'Unable to generate dataset.',
    };
  }

  return {
    status,
    datasetId: result.datasetId,
    done: true,
    resultArray: result.resultArray,
    replyToUser: buildDatasetReadyMessage(
      result.datasetId,
      result.resultArray,
      config,
    ),
  };
}

function buildDatasetReadyMessage(
  datasetId: string,
  resultArray: DbQueryWorkflowOutput['resultArray'],
  config?: {maxRowsForAI?: number},
): string {
  let resultSetString = '';
  if (resultArray) {
    const maxRows = config?.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI;
    resultSetString = ` First ${maxRows} results from the dataset are: ${JSON.stringify(resultArray)}`;
  }

  return `Dataset generated and has been rendered for the user. The dataset ID is ${datasetId}. Just tell the user that it is done.${resultSetString}`;
}

export function formatGetDataAsDatasetResult(result: JsonObject): string {
  const parsed = datasetToolResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return JSON.stringify(result);
  }

  return parsed.data.replyToUser;
}

export function getDataAsDatasetMetadata(result: JsonObject): JsonObject {
  const parsed = datasetToolResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return {status: 'failed'};
  }

  return {
    status: parsed.data.status,
    existingDatasetId: parsed.data.datasetId ?? null,
  };
}

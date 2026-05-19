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

const improveDatasetToolResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  done: z.boolean(),
  datasetId: z.string().optional(),
  replyToUser: z.string(),
  resultArray: z.array(z.object({}).passthrough()).optional(),
});

type ImproveDatasetToolResult = z.infer<typeof improveDatasetToolResultSchema>;

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
 * Mastra-native tool: improve-dataset
 *
 * Replaces the LangChain `ImproveDatasetTool` by running the
 * `dbQueryWorkflow` with an existing datasetId, streaming events
 * to the AsyncEventQueue.
 *
 * Used by the ChatWorkflow Agent when the user wants to modify an existing dataset.
 */
export const improveDatasetTool = createTool({
  id: 'improve-dataset',
  description:
    'Tool for improving an existing dataset based on user feedback. It takes a dataset ID and a prompt describing the desired changes, and returns an updated dataset. Call this only if you have a valid dataset ID available.',
  inputSchema: z.object({
    datasetId: z
      .string()
      .describe('UUID ID of the existing dataset to improve'),
    prompt: z
      .string()
      .describe(
        'A description of what changes or improvements the user wants in the existing dataset.',
      ),
  }),
  outputSchema: improveDatasetToolResultSchema,
  execute: async (
    inputData: {datasetId: string; prompt: string},
    {requestContext}: {requestContext?: RequestContext},
  ): Promise<ImproveDatasetToolResult> => {
    if (!requestContext) {
      throw new Error(
        'RequestContext is required for improve-dataset tool execution.',
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
      inputData: {
        prompt: inputData.prompt,
        schema,
        datasetId: inputData.datasetId,
      },
      requestContext,
    });

    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return {
          status: 'failed',
          done: false,
          replyToUser:
            'Request was cancelled before dataset improvement finished.',
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
        replyToUser: 'Unable to improve dataset.',
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
): ImproveDatasetToolResult {
  if (!result.done || !result.datasetId) {
    return {
      status: 'failed',
      done: false,
      replyToUser: result.replyToUser ?? 'Unable to improve dataset.',
    };
  }

  return {
    status: 'completed',
    datasetId: result.datasetId,
    done: true,
    resultArray: result.resultArray,
    replyToUser: buildDatasetImprovedMessage(
      result.datasetId,
      result.resultArray,
      config,
    ),
  };
}

function buildDatasetImprovedMessage(
  datasetId: string,
  resultArray: DbQueryWorkflowOutput['resultArray'],
  config?: {maxRowsForAI?: number},
): string {
  let resultSetString = '';
  if (resultArray) {
    const maxRows = config?.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI;
    resultSetString = ` First ${maxRows} results from the dataset are: ${JSON.stringify(resultArray)}`;
  }

  return `Dataset improved and has been rendered for the user. The dataset ID is ${datasetId}. Just tell the user that it is done.${resultSetString}`;
}

export function formatImproveDatasetResult(result: JsonObject): string {
  const parsed = improveDatasetToolResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return JSON.stringify(result);
  }

  return parsed.data.replyToUser;
}

export function getImproveDatasetMetadata(result: JsonObject): JsonObject {
  const parsed = improveDatasetToolResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return {status: 'failed'};
  }

  return {
    status: parsed.data.status,
    existingDatasetId: parsed.data.datasetId ?? null,
  };
}

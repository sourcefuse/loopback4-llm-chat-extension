import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import type {RequestContext} from '@mastra/core/request-context';
import {visualizationWorkflow} from '../visualization.workflow';
import {
  visualizationWorkflowInputSchema,
  visualizationWorkflowOutputSchema,
  type VisualizationWorkflowOutput,
} from '../visualization-workflow-schemas';
import type {LLMStreamEvent} from '../../../../graphs/event.types';
import type {AsyncEventQueue} from '../../../bridge/async-event-queue';
import type {JsonObject, JsonValue} from '../../../../types';

const looseObjectSchema = z.object({}).passthrough();

const visualizationToolResultSchema = z.object({
  status: z.enum(['completed', 'failed']),
  done: z.boolean(),
  datasetId: z.string().optional(),
  visualizerName: z.string().optional(),
  visualizerConfig: looseObjectSchema.optional(),
  error: z.string().optional(),
  replyToUser: z.string(),
});

type VisualizationToolResult = z.infer<typeof visualizationToolResultSchema>;

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

function buildFailureMessage(error?: string): string {
  return `Visualization could not be generated. Reason: ${error ?? 'Unknown reason'}`;
}

function buildSuccessMessage(config: JsonObject | undefined): string {
  return `Visualization rendered for the user with the following config: ${JSON.stringify(
    config ?? {},
    undefined,
    2,
  )}`;
}

function resolveRunFailureMessage(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    result.error instanceof Error
  ) {
    return result.error.message;
  }

  return 'Visualization workflow execution failed.';
}

function formatResult(
  result: VisualizationWorkflowOutput,
): VisualizationToolResult {
  if (
    !result.done ||
    !result.datasetId ||
    !result.visualizerName ||
    result.error
  ) {
    const errorMessage = result.error ?? 'Unknown reason';
    return {
      status: 'failed',
      done: false,
      datasetId: result.datasetId,
      visualizerName: result.visualizerName,
      visualizerConfig: result.visualizerConfig,
      error: errorMessage,
      replyToUser: buildFailureMessage(errorMessage),
    };
  }

  return {
    status: 'completed',
    done: true,
    datasetId: result.datasetId,
    visualizerName: result.visualizerName,
    visualizerConfig: result.visualizerConfig ?? {},
    replyToUser: buildSuccessMessage(result.visualizerConfig as JsonObject),
  };
}

/**
 * Mastra-native tool: generate-visualization
 *
 * Replaces the LangChain GenerateVisualizationTool by running the
 * VisualizationWorkflow directly, forwarding step events to AsyncEventQueue.
 */
export const generateVisualizationTool = createTool({
  id: 'generate-visualization',
  description: `Generates a visualization for the user's request. It takes in a prompt and an optional dataset ID.
If the user's request involves trends, growth, decline, comparisons, distributions, patterns, correlations, or any analytical insight, ALWAYS use this tool instead of 'get-data-as-dataset'.
No need to call 'get-data-as-dataset' tool before this - if the dataset ID is not provided, this tool will internally fetch the data to be visualized.
It does not return anything, instead it fires an event internally that renders the visualization on the UI for the user to see.`,
  inputSchema: visualizationWorkflowInputSchema,
  outputSchema: visualizationToolResultSchema,
  execute: async (
    inputData: z.infer<typeof visualizationWorkflowInputSchema>,
    {requestContext}: {requestContext?: RequestContext},
  ): Promise<VisualizationToolResult> => {
    if (!requestContext) {
      throw new Error(
        'RequestContext is required for generate-visualization tool execution.',
      );
    }

    const eventQueue = requestContext.get('eventQueue') as
      | AsyncEventQueue
      | undefined;
    const abortSignal = requestContext.get('abortSignal') as
      | AbortSignal
      | undefined;

    const run = await visualizationWorkflow.createRun();
    const stream = run.stream({
      inputData,
      requestContext,
    });

    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        return {
          status: 'failed',
          done: false,
          replyToUser:
            'Request was cancelled before visualization generation finished.',
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
      const errorMessage = resolveRunFailureMessage(finalResult);
      return {
        status: 'failed',
        done: false,
        error: errorMessage,
        replyToUser: buildFailureMessage(errorMessage),
      };
    }

    const parsedOutput = visualizationWorkflowOutputSchema.safeParse(
      finalResult.result,
    );

    if (!parsedOutput.success) {
      return {
        status: 'failed',
        done: false,
        error: 'Unable to parse visualization workflow output.',
        replyToUser: buildFailureMessage(
          'Unable to parse visualization workflow output.',
        ),
      };
    }

    return formatResult(parsedOutput.data);
  },
});

export function formatGenerateVisualizationResult(result: JsonObject): string {
  const parsed = visualizationToolResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return JSON.stringify(result);
  }

  return parsed.data.replyToUser;
}

export function getGenerateVisualizationMetadata(
  result: JsonObject,
): JsonObject {
  const parsed = visualizationToolResultSchema.safeParse(toJsonObject(result));
  if (!parsed.success) {
    return {status: 'failed'};
  }

  return {
    status: parsed.data.status,
    existingDatasetId: parsed.data.datasetId ?? null,
    config: (parsed.data.visualizerConfig as JsonObject | undefined) ?? null,
    visualization: parsed.data.visualizerName ?? null,
  };
}

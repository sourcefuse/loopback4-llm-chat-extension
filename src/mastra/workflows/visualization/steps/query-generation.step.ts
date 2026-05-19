import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import type {LLMStreamEvent} from '../../../../graphs/event.types';
import {dbQueryWorkflow} from '../../db-query/db-query.workflow';
import {
  dbQueryWorkflowOutputSchema,
  type DbQueryWorkflowOutput,
} from '../../db-query/db-query-workflow-schemas';
import {asVisualizationContext} from '../visualization-request-context';
import {visualizationWorkflowStateSchema} from '../visualization-workflow-schemas';

function isLLMStreamEvent(value: unknown): value is LLMStreamEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'data' in value
  );
}

function buildDatasetGenerationPrompt(inputData: {
  prompt: string;
  visualizerContext?: string;
}): string {
  return `Generate a query to fetch data for visualization based on the following user prompt: ${inputData.prompt}.${inputData.visualizerContext ? ` Ensure that the query structure satisfies the following context: ${inputData.visualizerContext}` : ''}`;
}

function buildDatasetFailureMessage(result: DbQueryWorkflowOutput): string {
  return result.replyToUser ?? 'Failed to create dataset for visualization';
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

  return 'Failed to create dataset for visualization';
}

export const queryGenerationStep = createStep({
  id: 'query-generation',
  inputSchema: z.object({
    prompt: z.string(),
    datasetId: z.string().optional(),
    visualizerName: z.string().optional(),
    visualizerContext: z.string().optional(),
    type: z.string().optional(),
    error: z.string().optional(),
  }),
  outputSchema: visualizationWorkflowStateSchema,
  execute: async ({inputData, requestContext, writer}) => {
    if (inputData.error !== undefined || inputData.datasetId !== undefined) {
      return inputData;
    }

    const ctx = asVisualizationContext(requestContext!);
    const schema = ctx.get('fullSchema');

    if (!schema) {
      throw new Error(
        'fullSchema not found in RequestContext. Ensure DB Query context is bound before visualization execution.',
      );
    }

    const run = await dbQueryWorkflow.createRun();
    const stream = run.stream({
      inputData: {
        datasetId: inputData.datasetId,
        directCall: true,
        prompt: buildDatasetGenerationPrompt(inputData),
        schema,
      },
      requestContext,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'workflow-step-output') {
        const output = chunk.payload?.output;
        if (isLLMStreamEvent(output)) {
          await writer.write(output);
        }
      }
    }

    const finalResult = await stream.result;
    if (finalResult.status !== 'success') {
      const failureMessage = resolveRunFailureMessage(finalResult);
      await writer.write({
        type: LLMStreamEventType.Error,
        data: {
          status: `Failed to create dataset for visualization: ${failureMessage}`,
        },
      });
      return {
        ...inputData,
        error: failureMessage,
      };
    }

    const parsedOutput = dbQueryWorkflowOutputSchema.safeParse(
      finalResult.result,
    );

    if (!parsedOutput.success || !parsedOutput.data.datasetId) {
      const fallbackResult = parsedOutput.success
        ? buildDatasetFailureMessage(parsedOutput.data)
        : 'Failed to create dataset for visualization';
      await writer.write({
        type: LLMStreamEventType.Error,
        data: {
          status: `Failed to create dataset for visualization: ${parsedOutput.success ? (parsedOutput.data.replyToUser ?? 'Unknown error') : 'Unknown error'}`,
        },
      });
      return {
        ...inputData,
        error: fallbackResult,
      };
    }

    return {
      ...inputData,
      datasetId: parsedOutput.data.datasetId,
    };
  },
});

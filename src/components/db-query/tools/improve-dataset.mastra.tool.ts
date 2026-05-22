import {service} from '@loopback/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IMastraGraphTool, ToolStatus} from '../../../graphs/types';
import {ImproveDatasetTool} from './improve-dataset.tool';

/**
 * Mastra-shaped wrapper around the legacy dataset-improvement tool.
 * Delegates to the existing LangGraph pipeline during the transition
 * window; P3 swaps the body to call the improveQueryWorkflow.
 */
export class MastraImproveDatasetTool implements IMastraGraphTool {
  key = 'improve-dataset';
  requireApproval = false;

  constructor(
    @service(ImproveDatasetTool)
    private readonly legacy: ImproveDatasetTool,
  ) {}

  build(): Tool {
    return createTool({
      id: this.key,
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
      execute: async (inputData, ctx) => {
        const writer = ctx?.requestContext?.get('eventWriter') as
          | ((e: LLMStreamEvent) => void)
          | undefined;
        const toolCallId =
          (ctx as unknown as {toolCallId?: string})?.toolCallId ?? this.key;
        writer?.({
          type: LLMStreamEventType.ToolStatus,
          data: {id: toolCallId, status: ToolStatus.Running},
        });
        try {
          const legacyTool = await this.legacy.build();
          const result = (await legacyTool.invoke(
            inputData as unknown as never,
            {configurable: {writer}} as never,
          )) as Record<string, unknown>;
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Completed},
          });
          return result;
        } catch (err) {
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Failed},
          });
          throw err;
        }
      },
    });
  }

  getValue(result: Record<string, unknown>): string {
    return this.legacy.getValue(result as Record<string, string>);
  }

  getMetadata(result: Record<string, unknown>) {
    return this.legacy.getMetadata(result as Record<string, string>);
  }
}

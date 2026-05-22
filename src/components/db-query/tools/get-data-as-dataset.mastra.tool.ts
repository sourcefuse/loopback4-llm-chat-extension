import {service} from '@loopback/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IMastraGraphTool, ToolStatus} from '../../../graphs/types';
import {GetDataAsDatasetTool} from './get-data-as-dataset.tool';

/**
 * Mastra-shaped wrapper around the legacy NL2SQL dataset tool. During the
 * transition window it delegates to the existing LangGraph `DbQueryGraph`
 * pipeline via the legacy tool's `.build().invoke()` so behaviour stays
 * byte-identical. P3 swaps the body to call
 * `mastra.getWorkflow('generateQueryWorkflow').createRun().start()` and
 * deletes the legacy class.
 *
 * Refs: MIGRATION-STRATEGY.md sections 8.1, 9.1, 9.4a.
 */
export class MastraGetDataAsDatasetTool implements IMastraGraphTool {
  key = 'get-data-as-dataset';
  requireApproval = false;

  constructor(
    @service(GetDataAsDatasetTool)
    private readonly legacy: GetDataAsDatasetTool,
  ) {}

  build(): Tool {
    return createTool({
      id: this.key,
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
      execute: async (inputData, ctx) => {
        const writer = ctx?.requestContext?.get('eventWriter') as
          | ((e: LLMStreamEvent) => void)
          | undefined;
        const toolCallId =
          (ctx as unknown as {toolCallId?: string})?.toolCallId ?? this.key;
        writer?.({
          type: LLMStreamEventType.Log,
          data: `Generating SQL for: ${inputData.prompt}`,
        });
        writer?.({
          type: LLMStreamEventType.ToolStatus,
          data: {id: toolCallId, status: ToolStatus.Running},
        });
        try {
          const legacyTool = await this.legacy.build();
          const result = (await legacyTool.invoke(
            inputData as unknown as never,
            // The legacy graph reads its writer from configurable.writer.
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

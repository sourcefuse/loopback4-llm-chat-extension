import {service} from '@loopback/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IMastraGraphTool, ToolStatus} from '../../../graphs/types';
import {GenerateVisualizationTool} from './generate-visualization.tool';

/**
 * Mastra-shaped wrapper around the legacy visualization tool. Delegates
 * to the existing VisualizationGraph via the legacy class's
 * .build().invoke() during the transition window. P3 swaps to
 * mastra.getWorkflow('visualizationWorkflow').createRun() and deletes
 * the legacy class.
 *
 * The visualization-type enum is generated on each .build() call from
 * the @visualizer()-decorated bindings discovered by the legacy class,
 * so consumer-side chart extensions remain plugin-compatible.
 */
export class MastraGenerateVisualizationTool implements IMastraGraphTool {
  key = 'generate-visualization';
  requireApproval = false;

  constructor(
    @service(GenerateVisualizationTool)
    private readonly legacy: GenerateVisualizationTool,
  ) {}

  build(): Tool {
    return createTool({
      id: this.key,
      description: `Generates a visualization for the user's request. It takes in a prompt and an optional dataset ID.
If the user's request involves trends, growth, decline, comparisons, distributions, patterns, correlations, or any analytical insight, ALWAYS use this tool instead of 'get-data-as-dataset'.
No need to call 'get-data-as-dataset' tool before this — if the dataset ID is not provided, this tool will internally fetch the data to be visualized.
It does not return anything, instead it fires an event internally that renders the visualization on the UI for the user to see.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            'Prompt from the user that will be used for generating the visualization.',
          ),
        datasetId: z
          .string()
          .optional()
          .describe(
            "ID of the dataset that needs to be visualized. Use the dataset ID from 'get-data-as-dataset' or 'improve-dataset' tool if available. If not provided, the tool will internally fetch the data.",
          ),
        type: z
          .string()
          .optional()
          .describe(
            'Type of visualization to be generated (bar, line, pie, etc.). If not provided, the system picks the best fit based on the data.',
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

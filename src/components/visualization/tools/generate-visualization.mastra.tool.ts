import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IMastraGraphTool, ToolStatus} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';

/**
 * Mastra-shaped visualization tool. Final form — calls
 * `mastra.getWorkflow('visualizationWorkflow').createRun().start()`.
 * The visualizer-type enum is no longer generated dynamically from the
 * legacy registry here; the renderVisualization step of the workflow
 * dispatches to @visualizer() classes via RequestContext at run time.
 */
export class MastraGenerateVisualizationTool implements IMastraGraphTool {
  key = 'generate-visualization';
  requireApproval = false;

  constructor(
    @inject(AiIntegrationBindings.Mastra) private readonly mastra: Mastra,
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
          const workflow = this.mastra.getWorkflow(
            'visualizationWorkflow' as never,
          );
          if (!workflow) {
            throw new Error(
              "visualizationWorkflow not registered in Mastra — check MastraProvider's workflows config",
            );
          }
          const run = await workflow.createRun();
          const result = await run.start({
            inputData: {
              datasetId: inputData.datasetId ?? '',
              userQuery: inputData.prompt,
            },
            requestContext: ctx?.requestContext,
          } as never);
          if (result.status === 'suspended') {
            // HITL — emit AwaitingApproval, return empty. Resume in v3.1.
            writer?.({
              type: LLMStreamEventType.ToolStatus,
              data: {id: toolCallId, status: ToolStatus.AwaitingApproval},
            });
            return {};
          }
          if (result.status !== 'success') {
            throw new Error(`Visualization failed: ${result.status}`);
          }
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Completed},
          });
          return (result as {result?: unknown}).result ?? {};
        } catch (err) {
          // Single Failed emit.
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Failed},
          });
          throw err;
        }
      },
    });
  }
}

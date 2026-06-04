import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {createTool} from '@mastra/core/tools';
import type {Tool, ToolExecutionContext} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IGraphTool, ToolStatus} from '../../../graphs/types';
import {
  asEventWriter,
  asRecord,
  readString,
} from '../../../graphs/tool-event.util';
import {MastraInternalBindings} from '../../../mastra/internal-bindings';

/**
 * Mastra-shaped visualization tool. Final form — calls
 * `mastra.getWorkflow('visualizationWorkflow').createRun().start()`.
 * The visualizer-type enum is no longer generated dynamically from the
 * legacy registry here; the renderVisualization step of the workflow
 * dispatches to @visualizer() classes via RequestContext at run time.
 */
export class GenerateVisualizationTool implements IGraphTool {
  key = 'generate-visualization';
  constructor(
    @inject(MastraInternalBindings.Mastra) private readonly mastra: Mastra,
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
        const writer = asEventWriter(ctx.requestContext?.get('eventWriter'));
        const toolCallId = ctx.agent?.toolCallId ?? this.key;
        writer?.({
          type: LLMStreamEventType.ToolStatus,
          data: {id: toolCallId, status: ToolStatus.Running},
        });
        try {
          return await this.runVisualizationWorkflow(
            writer,
            toolCallId,
            inputData.datasetId ?? '',
            inputData.prompt,
            inputData.type,
            ctx,
          );
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

  private async runVisualizationWorkflow(
    writer: ((e: LLMStreamEvent) => void) | undefined,
    toolCallId: string,
    datasetId: string,
    userQuery: string,
    requestedType: string | undefined,
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const workflow = this.mastra.getWorkflow('visualizationWorkflow');
    if (!workflow) {
      throw new Error(
        "visualizationWorkflow not registered in Mastra — check MastraProvider's workflows config",
      );
    }
    const run = await workflow.createRun();
    // Forward tool tracing context so the workflow nests under the agent's
    // root span (one trace per /reply). See get-data-as-dataset for the
    // long version of this rationale.
    const result = await run.start({
      inputData: {datasetId, userQuery, type: requestedType},
      requestContext: ctx.requestContext,
      tracing: ctx.tracing,
    });
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
    // visualizationWorkflow's final step is `.then(renderVisualizationStep)`
    // (not a `.branch()`), so the result lands directly on the top level
    // — no branch-key unwrap needed.
    const root = asRecord(result);
    const rawResult = asRecord(root.result);
    const workflowResult = {
      chartConfig: rawResult.chartConfig,
      visualization: readString(rawResult.visualization),
      datasetId: readString(rawResult.datasetId),
      sql: readString(rawResult.sql),
      description: readString(rawResult.description),
    };
    this.emitVisualizationResult(writer, toolCallId, workflowResult);
    return workflowResult;
  }

  /**
   * Emit the final Tool event the UI renders the chart from, then a
   * Completed ToolStatus. The UI's renderVizFromToolEvent reads
   * `data.visualization` as the chart TYPE and `data.config` as the
   * chart settings (see sandbox app.js renderChart signature).
   */
  private emitVisualizationResult(
    writer: ((e: LLMStreamEvent) => void) | undefined,
    toolCallId: string,
    workflowResult: {
      chartConfig?: unknown;
      visualization?: string;
      datasetId?: string;
      sql?: string;
      description?: string;
    },
  ): void {
    writer?.({
      type: LLMStreamEventType.Tool,
      data: {
        id: toolCallId,
        tool: this.key,
        data: {
          visualization: workflowResult.visualization ?? '',
          config: workflowResult.chartConfig ?? {},
          datasetId: workflowResult.datasetId ?? '',
          existingDatasetId: workflowResult.datasetId ?? '',
          sql: workflowResult.sql ?? '',
          description: workflowResult.description ?? '',
        },
      },
    });
    writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {id: toolCallId, status: ToolStatus.Completed},
    });
  }
}

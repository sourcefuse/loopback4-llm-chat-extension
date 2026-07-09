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
import {AiIntegrationBindings} from '../../../keys';
import {graphTool} from '../../../decorators';
import {buildDatasetReadout} from '../utils';

/**
 * Mastra-shaped dataset-improvement tool. Calls the single
 * `mastra.getWorkflow('dbQueryGraph').createRun().start()` (the same graph the
 * get-data-as-dataset tool uses); passing a `datasetId` routes the graph's
 * entry node to the improve path.
 */
@graphTool()
export class ImproveDatasetTool implements IGraphTool {
  needsReview = false;
  key = 'improve-dataset';
  constructor(
    @inject(AiIntegrationBindings.Mastra) private readonly mastra: Mastra,
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
        const writer = asEventWriter(ctx.requestContext?.get('eventWriter'));
        const toolCallId = ctx.agent?.toolCallId ?? this.key;
        writer?.({
          type: LLMStreamEventType.ToolStatus,
          data: {id: toolCallId, status: ToolStatus.Running},
        });
        try {
          return await this.runImproveGraph(writer, toolCallId, inputData, ctx);
        } catch (err) {
          // Single Failed emit — non-success branch throws above.
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Failed},
          });
          throw err;
        }
      },
    });
  }

  private extractImproveResult(result: unknown): {
    datasetId?: string;
    sql?: string;
  } {
    // dbQueryGraph ends with `.then(isImprovementNode)` (not a `.branch()`), and
    // that entry node already flattened the improve sub-graph's branch output,
    // so the flat contract lands directly on the top-level result.
    const out = asRecord(asRecord(result).result);
    return {
      datasetId: readString(out.datasetId),
      sql: readString(out.sql),
    };
  }

  private async runImproveGraph(
    writer: ((e: LLMStreamEvent) => void) | undefined,
    toolCallId: string,
    inputData: {datasetId: string; prompt: string},
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const workflow = this.mastra.getWorkflow('dbQueryGraph');
    if (!workflow) {
      throw new Error(
        'dbQueryGraph not registered in Mastra — check Provider workflows config',
      );
    }
    const run = await workflow.createRun();
    // Forward tool tracing context so the workflow nests under the agent's
    // root span (one trace per /reply). See get-data-as-dataset for the
    // long version of this rationale.
    const result = await run.start({
      inputData,
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
      throw new Error(`Improve dataset failed: ${result.status}`);
    }
    const workflowResult = this.extractImproveResult(result);
    const datasetId = workflowResult.datasetId ?? '';
    // Emit final Tool event so the UI can attach the SQL/template
    // badge and like/dislike footer (app.js reads
    // evtData.data.datasetId off the `tool` event). No row count is sent —
    // the UI grid re-fetches and renders rows itself from the datasetId.
    writer?.({
      type: LLMStreamEventType.Tool,
      data: {
        id: toolCallId,
        tool: this.key,
        data: {
          datasetId,
          sql: workflowResult.sql ?? '',
        },
      },
    });
    writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        id: toolCallId,
        status: datasetId ? ToolStatus.Completed : ToolStatus.Failed,
      },
    });
    const rc = ctx.requestContext;
    // Acknowledge "done + datasetId" to the AI, never the actual data
    // (unless the consumer opted in via readAccessForAI). Returning a
    // string keeps the row count and result rows out of the model context.
    return buildDatasetReadout({
      datasetId,
      verb: 'updated',
      store: rc?.get('datasetStore'),
      config: rc?.get('config'),
    });
  }
}

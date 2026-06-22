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
  pickBranchOutput,
  readString,
} from '../../../graphs/tool-event.util';
import {InternalBindings} from '../../../mastra/internal-bindings';
import {buildDatasetReadout} from '../utils';

/**
 * Mastra-shaped dataset-improvement tool. Final form — calls
 * `mastra.getWorkflow('improveQueryWorkflow').createRun().start()`.
 */
export class ImproveDatasetTool implements IGraphTool {
  key = 'improve-dataset';
  constructor(
    @inject(InternalBindings.Mastra) private readonly mastra: Mastra,
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
          return await this.runImproveWorkflow(
            writer,
            toolCallId,
            inputData,
            ctx,
          );
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

  private extractImproveBranchResult(result: unknown): {
    datasetId?: string;
    sql?: string;
  } {
    // improveQueryWorkflow ends with a `.branch()` keyed by
    // `save-improved` vs `failed`; unwrap whichever fired.
    const root = asRecord(result);
    const rawResult = asRecord(root.result);
    const saveResult = asRecord(rawResult['save-improved']);
    const failedResult = asRecord(rawResult.failed);
    const branchOutput = pickBranchOutput(saveResult, failedResult, rawResult);
    return {
      datasetId: readString(branchOutput.datasetId),
      sql: readString(branchOutput.sql),
    };
  }

  private async runImproveWorkflow(
    writer: ((e: LLMStreamEvent) => void) | undefined,
    toolCallId: string,
    inputData: {datasetId: string; prompt: string},
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const workflow = this.mastra.getWorkflow('improveQueryWorkflow');
    if (!workflow) {
      throw new Error(
        'improveQueryWorkflow not registered in Mastra — check Provider workflows config',
      );
    }
    const run = await workflow.createRun();
    // Do NOT forward `tracing: ctx.tracing` — on follow-up turns it carries a
    // stale traceId and the workflow spans get orphaned/dropped. Self-root so
    // the workflow is always a complete (separate) trace. See get-data-as-
    // dataset for the full rationale.
    const result = await run.start({
      inputData,
      requestContext: ctx.requestContext,
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
    const workflowResult = this.extractImproveBranchResult(result);
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

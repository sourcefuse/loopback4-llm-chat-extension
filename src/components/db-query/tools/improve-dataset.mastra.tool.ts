import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IMastraGraphTool, ToolStatus} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryConfig, IDataSetStore} from '../types';
import {buildDatasetReadout} from '../utils';

/**
 * Mastra-shaped dataset-improvement tool. Final form — calls
 * `mastra.getWorkflow('improveQueryWorkflow').createRun().start()`.
 */
export class MastraImproveDatasetTool implements IMastraGraphTool {
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
    const rawResult =
      (result as {result?: Record<string, unknown>}).result ?? {};
    const branchOutput =
      (rawResult['save-improved'] as Record<string, unknown> | undefined) ??
      (rawResult['failed'] as Record<string, unknown> | undefined) ??
      rawResult;
    return branchOutput as {
      datasetId?: string;
      sql?: string;
    };
  }

  private async runImproveWorkflow(
    writer: ((e: LLMStreamEvent) => void) | undefined,
    toolCallId: string,
    inputData: {datasetId: string; prompt: string},
    ctx: unknown,
  ): Promise<unknown> {
    const workflow = this.mastra.getWorkflow('improveQueryWorkflow' as never);
    if (!workflow) {
      throw new Error(
        "improveQueryWorkflow not registered in Mastra — check MastraProvider's workflows config",
      );
    }
    const run = await workflow.createRun();
    // Forward tool tracing context so the workflow nests under the agent's
    // root span (one trace per /reply). See get-data-as-dataset for the
    // long version of this rationale.
    const toolCtx = ctx as {
      requestContext?: unknown;
      tracing?: {currentSpan?: unknown};
    };
    const result = await run.start({
      inputData,
      requestContext: toolCtx.requestContext,
      tracing: toolCtx.tracing,
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
    const rc = (ctx as {requestContext?: {get: (k: string) => unknown}})
      ?.requestContext;
    // Acknowledge "done + datasetId" to the AI, never the actual data
    // (unless the consumer opted in via readAccessForAI). Returning a
    // string keeps the row count and result rows out of the model context.
    return buildDatasetReadout({
      datasetId,
      verb: 'updated',
      store: rc?.get('datasetStore') as IDataSetStore | undefined,
      config: rc?.get('config') as DbQueryConfig | undefined,
    });
  }
}

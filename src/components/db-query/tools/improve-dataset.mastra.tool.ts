import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IMastraGraphTool, ToolStatus} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';

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
          const workflow = this.mastra.getWorkflow(
            'improveQueryWorkflow' as never,
          );
          if (!workflow) {
            throw new Error(
              "improveQueryWorkflow not registered in Mastra — check MastraProvider's workflows config",
            );
          }
          const run = await workflow.createRun();
          const result = await run.start({
            inputData,
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
            throw new Error(`Improve dataset failed: ${result.status}`);
          }
          // improveQueryWorkflow ends with a `.branch()` keyed by
          // `save-improved` vs `failed`; unwrap whichever fired.
          const rawResult =
            (result as {result?: Record<string, unknown>}).result ?? {};
          const branchOutput =
            (rawResult['save-improved'] as
              | Record<string, unknown>
              | undefined) ??
            (rawResult['failed'] as Record<string, unknown> | undefined) ??
            rawResult;
          const workflowResult = branchOutput as {
            datasetId?: string;
            sql?: string;
            rowCount?: number;
          };
          // Emit final Tool event so the UI can attach the SQL/template
          // badge and like/dislike footer (app.js reads
          // evtData.data.datasetId off the `tool` event).
          writer?.({
            type: LLMStreamEventType.Tool,
            data: {
              id: toolCallId,
              tool: this.key,
              data: {
                datasetId: workflowResult.datasetId ?? '',
                sql: workflowResult.sql ?? '',
                rowCount: workflowResult.rowCount ?? 0,
              },
            },
          });
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Completed},
          });
          return workflowResult;
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
}

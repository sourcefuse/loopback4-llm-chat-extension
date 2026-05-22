import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {LLMStreamEvent, LLMStreamEventType} from '../../../graphs/event.types';
import {IMastraGraphTool, ToolStatus} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';

/**
 * Mastra-shaped NL2SQL tool. Final form — calls
 * `mastra.getWorkflow('generateQueryWorkflow').createRun().start()`
 * directly; no more legacy IGraphTool delegation. The workflow itself
 * still has stub step bodies until real DbQueryService
 * helpers are wired into each step.
 */
export class MastraGetDataAsDatasetTool implements IMastraGraphTool {
  key = 'get-data-as-dataset';
  requireApproval = false;

  constructor(
    @inject(AiIntegrationBindings.Mastra) private readonly mastra: Mastra,
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
          const workflow = this.mastra.getWorkflow(
            'generateQueryWorkflow' as never,
          );
          if (!workflow) {
            throw new Error(
              "generateQueryWorkflow not registered in Mastra — check MastraProvider's workflows config",
            );
          }
          const run = await workflow.createRun();
          const result = await run.start({
            inputData,
            requestContext: ctx?.requestContext,
          } as never);
          if (result.status === 'suspended') {
            // HITL — emit AwaitingApproval, return empty so the Agent
            // pauses. Resume flow lands with the ApprovalController in
            // v3.1 (Phase 4 of the migration plan).
            writer?.({
              type: LLMStreamEventType.ToolStatus,
              data: {id: toolCallId, status: ToolStatus.AwaitingApproval},
            });
            return {};
          }
          if (result.status !== 'success') {
            throw new Error(`Query generation failed: ${result.status}`);
          }
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Completed},
          });
          return (result as {result?: unknown}).result ?? {};
        } catch (err) {
          // Single Failed emit. Status-not-success path throws above
          // without emitting; this catch is the only Failed source.
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

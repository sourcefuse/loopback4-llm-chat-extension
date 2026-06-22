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
 * Mastra-shaped NL2SQL tool. Final form — calls
 * `mastra.getWorkflow('generateQueryWorkflow').createRun().start()`
 * directly; no more legacy IGraphTool delegation. The workflow itself
 * still has stub step bodies until real DbQueryService
 * helpers are wired into each step.
 */
export class GetDataAsDatasetTool implements IGraphTool {
  key = 'get-data-as-dataset';
  constructor(
    @inject(InternalBindings.Mastra) private readonly mastra: Mastra,
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
        const writer = asEventWriter(ctx.requestContext?.get('eventWriter'));
        const toolCallId = ctx.agent?.toolCallId ?? this.key;
        // Emit a single tool-started status. The granular per-stage progress
        // ('Generating SQL query…', 'Validating…') is emitted by the workflow
        // steps themselves, so a pre-workflow 'Generating SQL' Log here would
        // be premature (fires before generation) and redundant.
        writer?.({
          type: LLMStreamEventType.ToolStatus,
          data: {id: toolCallId, status: ToolStatus.Running},
        });
        try {
          return await this.runQueryWorkflow(
            writer,
            toolCallId,
            inputData,
            ctx,
          );
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

  private extractQueryBranchResult(result: unknown): {
    datasetId?: string;
    sql?: string;
    replyToUser?: string;
  } {
    // Mastra wraps the matched branch's output under the branch step id
    // (mirroring `.parallel()` fan-in shape), so unwrap the
    // `save-dataset`/`failed` key when present.
    const root = asRecord(result);
    const rawResult = asRecord(root.result);
    const saveResult = asRecord(rawResult['save-dataset']);
    const failedResult = asRecord(rawResult.failed);
    const branchOutput = pickBranchOutput(saveResult, failedResult, rawResult);
    return {
      datasetId: readString(branchOutput.datasetId),
      sql: readString(branchOutput.sql),
      replyToUser: readString(branchOutput.replyToUser),
    };
  }

  private async runQueryWorkflow(
    writer: ((e: LLMStreamEvent) => void) | undefined,
    toolCallId: string,
    inputData: {prompt: string},
    ctx: ToolExecutionContext,
  ): Promise<unknown> {
    const workflow = this.mastra.getWorkflow('generateQueryWorkflow');
    if (!workflow) {
      throw new Error(
        'generateQueryWorkflow not registered in Mastra — check Provider workflows config',
      );
    }
    const run = await workflow.createRun();
    // NOTE: we deliberately do NOT forward `tracing: ctx.tracing` here.
    // Forwarding it nests the workflow under the agent span ONLY on the first
    // turn of a conversation; on follow-up turns `ctx.tracing` carries a span
    // whose traceId belongs to a previous turn, so every workflow child span
    // references a parent the current trace's exporter never receives and they
    // are dropped as "orphaned events" (workflow invisible in LangSmith). Self-
    // rooting the workflow run keeps all its spans in one (separate) trace on
    // every turn — complete observability over pretty nesting. Tracked upstream
    // as a Mastra multi-turn tracing-context propagation bug.
    const result = await run.start({
      inputData,
      requestContext: ctx.requestContext,
    });
    if (result.status === 'suspended') {
      // HITL — emit AwaitingApproval, return empty so the Agent pauses.
      // Resume flow lands with the ApprovalController in v3.1.
      writer?.({
        type: LLMStreamEventType.ToolStatus,
        data: {id: toolCallId, status: ToolStatus.AwaitingApproval},
      });
      return {};
    }
    if (result.status !== 'success') {
      throw new Error(`Query generation failed: ${result.status}`);
    }
    const workflowResult = this.extractQueryBranchResult(result);
    const datasetId = workflowResult.datasetId ?? '';
    // Emit final Tool event so the UI's chat bubble can attach the
    // SQL/template badge and the like/dislike footer (app.js reads
    // evtData.data.datasetId off the `tool` event). No row count is sent —
    // the UI grid fetches and renders rows itself from the datasetId.
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
    // Unanswerable fast-fail: the workflow stopped at the get-columns gate
    // because no table holds the requested data. Hand the agent the
    // clarification so it asks the user to rephrase — instead of the
    // generic "generated dataset" readout over an empty id.
    if (!datasetId && workflowResult.replyToUser) {
      return workflowResult.replyToUser;
    }
    // Hand the AI a "done + datasetId" acknowledgement, never the actual
    // data (unless the consumer opted in via readAccessForAI). Returning a
    // string — not {datasetId, sql, rowCount} — keeps the row count and
    // result rows out of the model's context.
    return buildDatasetReadout({
      datasetId,
      verb: 'generated',
      store: rc?.get('datasetStore'),
      config: rc?.get('config'),
    });
  }
}

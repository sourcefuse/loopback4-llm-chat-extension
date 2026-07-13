import {inject} from '@loopback/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {IGraphTool, ToolStatus} from '../../../graphs/types';
import {LLMStreamEventType} from '../../../graphs/event.types';
import {asEventWriter} from '../../../graphs/tool-event.util';
import {graphTool} from '../../../decorators';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbSchemaHelperService} from '../services';
import {SchemaStore} from '../services/schema.store';
import {getCheapLlm, tracedGenerateText, type MastraRc} from '../_helpers';
import type {IDataSetStore} from '../types';

/**
 * Mastra-shaped dataset Q&A tool. Read-only: load the saved dataset, build a
 * single-turn prompt from its query + compressed schema + context, and make ONE
 * cheap-tier LLM call to phrase the answer.
 *
 * This mirrors the LangGraph version exactly — v2 ran a
 * `RunnableSequence([prompt, CheapLLM, stripThinkingTokens])`; the Mastra
 * equivalent is a single `tracedGenerateText` call on the cheap-tier model
 * resolved from the RequestContext. No dedicated agent is needed: a one-shot
 * completion has no tools/memory, and `tracedGenerateText` already emits a
 * MODEL_GENERATION span (the same tracing every db-query node gets).
 */
@graphTool()
export class AskAboutDatasetTool implements IGraphTool {
  needsReview = false;
  key = 'ask-about-dataset';
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks: string[] | undefined,
    @inject('services.DbSchemaHelperService')
    private readonly schemaHelper: DbSchemaHelperService,
    @inject('services.SchemaStore')
    private readonly schemaStore: SchemaStore,
  ) {}

  build(): Tool {
    return createTool({
      id: this.key,
      description:
        "Answer a follow-up question about a dataset you already generated in this conversation (you have its id) — INCLUDING which columns, filters, date/month conditions, sort orders, or joins were applied and how the data was selected. It reads the dataset's stored query, so it knows the real answer — use it instead of saying you lack visibility or guessing. Requires a valid dataset ID.",
      inputSchema: z.object({
        datasetId: z
          .string()
          .describe('uuid ID of the dataset to answer the question for'),
        question: z
          .string()
          .describe('The question that the user asked about the query.'),
      }),
      execute: async ({datasetId, question}, ctx) => {
        // Emit the Running → Completed/Failed tool-status lifecycle so the UI
        // shows this tool's progress like the other db-query tools (and like
        // the v2 tool events which carried `status: 'running'`).
        const writer = asEventWriter(ctx?.requestContext?.get('eventWriter'));
        const toolCallId = ctx?.agent?.toolCallId ?? this.key;
        writer?.({
          type: LLMStreamEventType.ToolStatus,
          data: {id: toolCallId, status: ToolStatus.Running},
        });
        try {
          // Cheap-tier model from the request context (v2 injected CheapLLM).
          // Read at execute time — resolved tiers are bound late, per request.
          const model = getCheapLlm(
            ctx?.requestContext as MastraRc | undefined,
          );
          if (!model) {
            writer?.({
              type: LLMStreamEventType.ToolStatus,
              data: {id: toolCallId, status: ToolStatus.Failed},
            });
            return "I couldn't reach a model to explain that dataset. Please try again.";
          }
          const {query, tables} = await this.store.findById(datasetId);
          const compressedSchema = this.schemaStore.filteredSchema(tables);
          const context = [
            ...(this.checks ?? []),
            ...this.schemaHelper.getTablesContext(compressedSchema),
          ].join('\n');
          const prompt = [
            'You explain an existing dataset to the user in plain language, based on the query that produced it. You MAY tell them which columns, filters, date/month conditions, sort orders, or joins were applied — that is the point of this tool.',
            'Do NOT paste the raw SQL text or expose internal IDs; describe what it does in plain terms.',
            `Here is the query that the question was for - ${query}`,
            `and here is the schema the query was generated for - ${JSON.stringify(compressedSchema)}`,
            `and here is the context that was provided for the query - ${context}`,
            `and here is the user's question - ${question}`,
          ].join('\n');

          const result = await tracedGenerateText({
            model,
            prompt,
            tracing: ctx?.tracing,
            label: 'ask-about-dataset',
            resultType: 'response_generation',
          });
          writer?.({
            type: LLMStreamEventType.ToolStatus,
            data: {id: toolCallId, status: ToolStatus.Completed},
          });
          return stripThinkingTokens(result.text);
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
}

import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import {z} from 'zod';
import {IGraphTool} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {graphTool} from '../../../decorators';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbSchemaHelperService} from '../services';
import {SchemaStore} from '../services/schema.store';
import type {IDataSetStore} from '../types';

/**
 * Mastra-shaped dataset Q&A tool. Read-only chain: load the saved
 * dataset, build a single-turn instruction containing the query +
 * compressed schema + context, hand to a one-shot Mastra Agent backed
 * by the consumer-bound ChatLLM. No workflow needed — the legacy
 * RunnableSequence (PromptTemplate -> LLM -> stripThinkingTokens)
 * collapses to one agent.generate() call.
 */
@graphTool()
export class AskAboutDatasetTool implements IGraphTool {
  key = 'ask-about-dataset';
  constructor(
    @inject(AiIntegrationBindings.Mastra)
    private readonly mastra: Mastra,
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

        // Use the agent registered on the singleton instead of constructing a
        // new Agent per call. A registered agent's spans reach the configured
        // observability exporter (Langfuse/LangSmith); a detached new Agent()
        // emits no traces and re-builds model/instruction plumbing on every
        // invocation. Pass requestContext so the per-request model binding
        // (agentModel) is honoured and spans attach to the parent trace.
        const agent = this.mastra.getAgent('ask-about-dataset-agent');
        const result = await agent.generate(prompt, {
          requestContext: ctx?.requestContext,
        });
        return result.text ?? '';
      },
    });
  }
}

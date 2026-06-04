import {inject} from '@loopback/core';
import {Agent} from '@mastra/core/agent';
import {createTool} from '@mastra/core/tools';
import type {Tool} from '@mastra/core/tools';
import type {MastraModelConfig} from '@mastra/core/llm';
import {z} from 'zod';
import {IGraphTool} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
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
export class AskAboutDatasetTool implements IGraphTool {
  key = 'ask-about-dataset';
  constructor(
    @inject(AiIntegrationBindings.ChatLLM, {optional: true})
    private readonly chatLlm: MastraModelConfig | undefined,
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
        'Tool for answering questions about an existing dataset, note that it can only answer questions about the dataset definition, not the data it contains. Call this only if you have a valid dataset ID available.',
      inputSchema: z.object({
        datasetId: z
          .string()
          .describe('uuid ID of the dataset to answer the question for'),
        question: z
          .string()
          .describe('The question that the user asked about the query.'),
      }),
      execute: async ({datasetId, question}) => {
        const {query, tables} = await this.store.findById(datasetId);
        const compressedSchema = this.schemaStore.filteredSchema(tables);
        const context = [
          ...(this.checks ?? []),
          ...this.schemaHelper.getTablesContext(compressedSchema),
        ].join('\n');
        const prompt = [
          "You are an AI assistant that answers questions about a query, without revealing any technical details, you need to answer the question the user's question.",
          "Make sure you don't reveal the original query to the user, just answer the question based on the query.",
          `Here is the query that the question was for - ${query}`,
          `and here is the schema the query was generated for - ${JSON.stringify(compressedSchema)}`,
          `and here is the context that was provided for the query - ${context}`,
          `and here is the user's question - ${question}`,
        ].join('\n');

        const model = this.chatLlm ?? process.env.MASTRA_DEFAULT_CHAT_MODEL;
        if (!model) {
          throw new Error(
            'ask-about-dataset: bind AiIntegrationBindings.ChatLLM ' +
              'or set MASTRA_DEFAULT_CHAT_MODEL. No silent OpenAI fallback.',
          );
        }
        const agent = new Agent({
          id: 'ask-about-dataset-agent',
          name: 'AskAboutDatasetAgent',
          instructions:
            'Answer the user question concisely. Do not reveal the underlying SQL.',
          model,
        });
        const result = await agent.generate(prompt);
        return result.text ?? '';
      },
    });
  }
}

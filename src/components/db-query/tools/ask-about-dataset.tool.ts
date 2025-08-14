import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {tool} from '@langchain/core/tools';
import {inject} from '@loopback/context';
import {service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import z from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbSchemaHelperService} from '../services';
import {SchemaStore} from '../services/schema.store';
import {IDataSetStore} from '../types';

@graphTool()
export class AskAboutDatasetTool implements IGraphTool {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly sqlllm: LLMProvider,
    @service(DbSchemaHelperService)
    private readonly dbSchemaHelper: DbSchemaHelperService,
    @service(SchemaStore)
    private readonly schemaStore: SchemaStore,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
  ) {}

  key = 'ask-about-dataset';
  needsReview = false;

  private readonly prompt =
    PromptTemplate.fromTemplate(`You are an AI assistant that answers questions about a query, without revealing any technical details, you need to answer the question the user's question.
  Make sure you don't reveal the original query to the user, just answer the question based on the query.
  Here is the query that the question was for -
  {query}

  and here is the schema the query was generated for -
  {schema}

  and here is the context that was provided for the query - 
  {context}

  and here is the user's question -
  {question}`);

  async build() {
    const chain = RunnableSequence.from([
      this.prompt,
      this.sqlllm,
      stripThinkingTokens,
    ]);

    const schema = z.object({
      datasetId: z
        .string()
        .describe('uuid ID of the dataset to answer the question for'),
      question: z
        .string()
        .describe('The question that the user asked about the query.'),
    }) as AnyObject[string];

    return tool(
      async (args: {datasetId: string; question: string}) => {
        const {query, tables} = await this.store.findById(args.datasetId);
        const compressedSchema = this.schemaStore.filteredSchema(tables);
        const response = await chain.invoke({
          query,
          question: args.question,
          schema: compressedSchema,
          context: [
            ...(this.checks ?? []),
            ...this.dbSchemaHelper.getTablesContext(compressedSchema),
          ].join('\n'),
        });
        return response;
      },
      {
        name: this.key,
        description:
          'Tool for answering questions about a query, note that it does not run the query and can only answer questions about the query itself, not the data it returns on execution. Call this only if you have a valid dataset ID available.',
        schema,
      },
    );
  }
}

import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {inject} from '@loopback/context';
import {service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {IGraphNode, LLMStreamEventType, RunnableConfig} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {stripThinkingTokens} from '../../../utils';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryNodes} from '../nodes.enum';
import {DbSchemaHelperService} from '../services';
import {SchemaStore} from '../services/schema.store';
import {TableSearchService} from '../services/search/table-search.service';
import {DbQueryState} from '../state';
import {DatabaseSchema, GenerationError} from '../types';

@graphNode(DbQueryNodes.GetTables)
export class GetTablesNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly llm: LLMProvider,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @service(SchemaStore)
    private readonly schemaStore: SchemaStore,
    @service(TableSearchService)
    private readonly tableSearchService: TableSearchService,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
  ) {}
  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are an AI assistant that extracts table names that are relevant to the users query that will be used to generate an SQL query later.
Please extract the relevant table names and return them as a comma separated list. Note there should be nothing else other than a comma separated list of exact same table names as in the input.
Ensure that table names are exact and match the names in the input including schema if given.
Use only and only the tables that are relevant to the query.
If you are not sure about the tables to select from the given schema, just return your doubt asking the user for more details or to rephrase the question in the following format -
failed attempt: <reason for failure>
</instructions>

<tables-with-description>
{tables}
</tables-with-description>

<user-question>
{query}
</user-question>

{checks}

{feedbacks}

<output-format>
table1, table2, table3
</output-format>`);

  feedbackPrompt = PromptTemplate.fromTemplate(`
<feedback-instructions>
We also need to consider the errors from last attempt at query generation.

In the last attempt, these were the last tables selected:
{lastTables}

But it was rejected with the following errors:
{feedback}

Use these if they are relevant to the table selection, otherwise ignore them, they would be considered again during the SQL generation step.
</feedback-instructions>
`);
  async execute(
    state: DbQueryState,
    config: RunnableConfig,
  ): Promise<DbQueryState> {
    const tableList = await this.tableSearchService.getTables(state.prompt, 10);
    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Selecting from tables: ${tableList}`,
    });
    const dbSchema = this.schemaStore.filteredSchema(tableList);
    const allTables = this._getTablesFromSchema(dbSchema);
    if (allTables.length === 0) {
      throw new Error(
        'No tables found in the provided database schema. Please ensure the schema is valid.',
      );
    }

    const chain = RunnableSequence.from([this.prompt, this.llm]);
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Extracting relevant tables from the schema',
      },
    });

    const result = await chain.invoke({
      tables: allTables.join('\n\n'),
      query: state.prompt,
      feedbacks: await this.getFeedbacks(state),
      checks: [
        `<must-follow-rules>`,
        'You must keep these additional details in consideration -',
        ...(this.checks ?? []),
        ...this.schemaHelper.getTablesContext(dbSchema),
        `</must-follow-rules>`,
      ].join('\n'),
    });

    const output = stripThinkingTokens(result);

    if (output.startsWith('failed attempt:')) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Table selection failed: ${output}`,
      });
      return {
        ...state,
        status: GenerationError.Failed,
        replyToUser: output.replace('failed attempt: ', ''),
      };
    }

    const lastLine = output.split('\n').pop() ?? '';
    const requiredTables = lastLine.split(',').map(t => t.trim());

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Picked tables - ${requiredTables.join(', ')}`,
    });

    if (requiredTables.length === 0) {
      throw new Error(
        'LLM did not return a valid comma separated string response.',
      );
    }

    return {
      ...state,
      schema: this.schemaStore.filteredSchema(requiredTables),
    };
  }

  async getFeedbacks(state: DbQueryState) {
    if (state.feedbacks) {
      const feedbacks = await this.feedbackPrompt.format({
        query: state.sql,
        feedback: state.feedbacks.join('\n'),
        lastTables: this._tableListFromSchema(state.schema).join(', '),
      });

      return feedbacks;
    }
    return '';
  }

  private _tableListFromSchema(schema: DatabaseSchema): string[] {
    if (!schema?.tables) {
      return [];
    }
    return Object.keys(schema.tables);
  }

  private _getTablesFromSchema(schema: DatabaseSchema): string[] {
    if (!schema?.tables) {
      return [];
    }
    return Object.keys(schema.tables).map(tableName => {
      const table = schema.tables[tableName];
      return `${tableName}: ${table.description}`;
    });
  }
}

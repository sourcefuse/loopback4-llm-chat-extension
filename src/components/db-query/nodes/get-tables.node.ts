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
import {DatabaseSchema, DbQueryConfig, GenerationError} from '../types';

@graphNode(DbQueryNodes.GetTables)
export class GetTablesNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llmCheap: LLMProvider,
    @inject(AiIntegrationBindings.SmartLLM)
    private readonly llmSmart: LLMProvider,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
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
- Consider not just the user query but also the context and the table descriptions while selecting the tables.
- Carefully consider each and every table before including or excluding it.
- If doubtful about a table's relevance, include it anyway to give the SQL generation step more options to choose from.
- Assume that the table would have appropriate columns for relating them to any other table even if the description does not mention it.
- If you are not sure about the tables to select from the given schema, just return your doubt asking the user for more details or to rephrase the question in the following format -
failed attempt: reason for failure
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
The output should be just a comma separated list of table names with no other text, comments or formatting.
Ensure that table names are exact and match the names in the input including schema if given.
<example-output>
public.employees, public.departments
</example-output>
In case of failure, return the failure message in the format -
failed attempt: <reason for failure>
<example-failure>
failed attempt: reason for failure
</example-failure>
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

    const useSmartLLM = this.config.nodes?.getTablesNode?.useSmartLLM ?? false;
    const llm = useSmartLLM ? this.llmSmart : this.llmCheap;

    const chain = RunnableSequence.from([this.prompt, llm]);
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Extracting relevant tables from the schema',
      },
    });

    let attempts = 0;
    let requiredTables: string[] = [];
    while (attempts < 2) {
      attempts++;
      const result = await chain.invoke({
        tables: allTables.join('\n\n'),
        query: state.prompt,
        feedbacks: await this.getFeedbacks(state),
        checks: [
          `<must-follow-rules>`,
          ...(this.checks ?? []).map(check => `- ${check}`),
          ...this.schemaHelper
            .getTablesContext(dbSchema)
            .map(check => `- ${check}`),
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
      requiredTables = lastLine.split(',').map(t => t.trim());
      if (this._validateTables(requiredTables, dbSchema)) {
        break;
      } else {
        if (attempts === 3) {
          return {
            ...state,
            status: GenerationError.Failed,
            replyToUser: `Not able to select relevant tables from the schema. Please rephrase the question or provide more details.`,
          };
        }
        config.writer?.({
          type: LLMStreamEventType.Log,
          data: `LLM returned invalid tables: ${lastLine}, trying again`,
        });
      }
    }

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

  private _validateTables(tables: string[], schema: DatabaseSchema): boolean {
    return tables.every(t => schema.tables[t] !== undefined);
  }
}

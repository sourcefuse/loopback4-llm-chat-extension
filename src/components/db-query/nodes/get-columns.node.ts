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
import {DbQueryState} from '../state';
import {
  ColumnSchema,
  DatabaseSchema,
  DbQueryConfig,
  GenerationError,
  TableSchema,
} from '../types';

@graphNode(DbQueryNodes.GetColumns)
export class GetColumnsNode implements IGraphNode<DbQueryState> {
  constructor(
    @inject(AiIntegrationBindings.CheapLLM)
    private readonly llm: LLMProvider,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks?: string[],
  ) {}

  prompt = PromptTemplate.fromTemplate(`
<instructions>
You are an AI assistant that identifies relevant columns from database tables based on a user's query.
Given a set of tables with their columns, you need to identify which columns are relevant to answer the user's query.

For each table, return only the column names that are relevant to the query. Include:
1. Columns directly mentioned or implied in the query
2. Primary key columns (always needed for joins and identification)
3. Foreign key columns (needed for relationships)
4. Columns that might be needed for filtering, sorting, or calculations
5. It is better to include a few extra relevant columns than to miss important ones.

Do not include:
- Columns that are clearly irrelevant to the query
- Descriptions, types, or any other metadata about the columns

Return the result as a JSON object where each table name is a key and the value is an array of relevant column names.
If you are not sure about which columns to select, return your doubt asking the user for more details in the following format:
failed attempt: <reason for failure>
</instructions>

<tables-with-columns>
{tablesWithColumns}
</tables-with-columns>

<user-question>
{query}
</user-question>

{checks}

{feedbacks}

<output-format>
Return a valid JSON object with table names as keys and arrays of column names as values.
Example format (do not copy these exact values):
{{
  "table_name1": ["column1", "column2", "column3"],
  "table_name2": ["column1", "column2"]
}}

In case of failure, return the failure message in the format:
failed attempt: <reason for failure>
</output-format>`);

  feedbackPrompt = PromptTemplate.fromTemplate(`
<feedback-instructions>
We also need to consider the errors from last attempt at query generation.

In the last attempt, these were the columns selected:
{lastColumns}

But it was rejected with the following errors:
{feedback}

Use these errors to refine your column selection. Consider if you need additional columns for joins, filtering, or calculations.
</feedback-instructions>
`);

  async execute(
    state: DbQueryState,
    config: RunnableConfig,
  ): Promise<DbQueryState> {
    if (!this.config.columnSelection) {
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Skipping column selection as per configuration`,
      });
      return state;
    }
    if (
      !state.schema?.tables ||
      Object.keys(state.schema.tables).length === 0
    ) {
      throw new Error(
        'No tables found in the schema. Please ensure the get-tables step was completed successfully.',
      );
    }

    const tablesWithColumns = this._getTablesWithColumns(state.schema);

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Selecting relevant columns from ${Object.keys(state.schema.tables).length} tables`,
    });

    const chain = RunnableSequence.from([this.prompt, this.llm]);
    config.writer?.({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: 'Extracting relevant columns from the schema',
      },
    });

    let attempts = 0;
    let selectedColumns: Record<string, string[]> = {};

    while (attempts < 3) {
      attempts++;
      const result = await chain.invoke({
        tablesWithColumns: tablesWithColumns.join('\n\n'),
        query: state.prompt,
        feedbacks: await this.getFeedbacks(state),
        checks: [
          `<must-follow-rules>`,
          ...(this.checks ?? []),
          ...this.schemaHelper.getTablesContext(state.schema),
          `</must-follow-rules>`,
        ].join('\n'),
      });

      const output = stripThinkingTokens(result);

      if (output.startsWith('failed attempt:')) {
        config.writer?.({
          type: LLMStreamEventType.Log,
          data: `Column selection failed: ${output}`,
        });
        return {
          ...state,
          status: GenerationError.Failed,
          replyToUser: output.replace('failed attempt: ', ''),
        };
      }

      try {
        // Extract JSON from the output
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          config.writer?.({
            type: LLMStreamEventType.Log,
            data: `Failed to find JSON in LLM response, trying again (attempt ${attempts})`,
          });
          continue;
        }

        selectedColumns = JSON.parse(jsonMatch[0]);

        if (this._validateColumns(selectedColumns, state.schema)) {
          break;
        } else {
          if (attempts === 3) {
            return {
              ...state,
              status: GenerationError.Failed,
              replyToUser: `Not able to select relevant columns from the schema. Please rephrase the question or provide more details.`,
            };
          }
          config.writer?.({
            type: LLMStreamEventType.Log,
            data: `LLM returned invalid columns, trying again (attempt ${attempts})`,
          });
        }
      } catch (error) {
        if (attempts === 3) {
          return {
            ...state,
            status: GenerationError.Failed,
            replyToUser: `Failed to parse column selection response. Please try again.`,
          };
        }
        config.writer?.({
          type: LLMStreamEventType.Log,
          data: `Failed to parse LLM response: ${error}, trying again (attempt ${attempts})`,
        });
      }
    }

    config.writer?.({
      type: LLMStreamEventType.Log,
      data: `Selected columns: ${JSON.stringify(selectedColumns, null, 2)}`,
    });

    // Create filtered schema with only selected columns
    const filteredSchema = this._createFilteredSchema(
      state.schema,
      selectedColumns,
    );

    return {
      ...state,
      schema: filteredSchema,
    };
  }

  async getFeedbacks(state: DbQueryState) {
    if (state.feedbacks) {
      const lastColumns = this._getSelectedColumnsFromSchema(state.schema);
      const feedbacks = await this.feedbackPrompt.format({
        feedback: state.feedbacks.join('\n'),
        lastColumns: JSON.stringify(lastColumns, null, 2),
      });

      return feedbacks;
    }
    return '';
  }

  private _getTablesWithColumns(schema: DatabaseSchema): string[] {
    return Object.entries(schema.tables).map(([tableName, table]) => {
      const columnDescriptions = Object.entries(table.columns).map(
        ([columnName, column]) => {
          const details = [
            `${columnName} (${column.type})`,
            column.required ? 'NOT NULL' : 'NULL',
            column.id ? 'PRIMARY KEY' : '',
            column.description ? `- ${column.description}` : '',
          ]
            .filter(Boolean)
            .join(' ');

          return `  - ${details}`;
        },
      );

      return `${tableName}: ${table.description}\nColumns:\n${columnDescriptions.join('\n')}`;
    });
  }

  private _validateColumns(
    selectedColumns: Record<string, string[]>,
    schema: DatabaseSchema,
  ): boolean {
    // Check if all tables exist in schema
    for (const tableName of Object.keys(selectedColumns)) {
      if (!schema.tables[tableName]) {
        return false;
      }

      // Check if all columns exist in the table
      const tableColumns = Object.keys(schema.tables[tableName].columns);
      for (const columnName of selectedColumns[tableName]) {
        if (!tableColumns.includes(columnName)) {
          return false;
        }
      }
    }
    return true;
  }

  private _createFilteredSchema(
    originalSchema: DatabaseSchema,
    selectedColumns: Record<string, string[]>,
  ): DatabaseSchema {
    const filteredTables: Record<string, TableSchema> = {};

    // Filter tables and columns based on selection
    for (const [tableName, columnNames] of Object.entries(selectedColumns)) {
      if (originalSchema.tables[tableName]) {
        const originalTable = originalSchema.tables[tableName];
        const filteredColumns: Record<string, ColumnSchema> = {};

        // Include selected columns
        for (const columnName of columnNames) {
          if (originalTable.columns[columnName]) {
            filteredColumns[columnName] = originalTable.columns[columnName];
          }
        }

        // Always include primary key columns if not already included
        for (const pkColumn of originalTable.primaryKey) {
          if (!filteredColumns[pkColumn] && originalTable.columns[pkColumn]) {
            filteredColumns[pkColumn] = originalTable.columns[pkColumn];
          }
        }

        filteredTables[tableName] = {
          ...originalTable,
          columns: filteredColumns,
        };
      }
    }

    // Filter relations to only include those between selected tables
    const filteredRelations = originalSchema.relations.filter(
      relation =>
        filteredTables[relation.table] &&
        filteredTables[relation.referencedTable],
    );

    return {
      tables: filteredTables,
      relations: filteredRelations,
    };
  }

  private _getSelectedColumnsFromSchema(
    schema: DatabaseSchema,
  ): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    for (const [tableName, table] of Object.entries(schema.tables)) {
      result[tableName] = Object.keys(table.columns);
    }

    return result;
  }
}

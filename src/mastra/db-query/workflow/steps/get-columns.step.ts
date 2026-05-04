import {generateText} from 'ai';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  ColumnSchema,
  DatabaseSchema,
  DbQueryConfig,
  GenerationError,
  TableSchema,
} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')('ai-integration:mastra:db-query:get-columns');

const GET_COLUMNS_PROMPT = `
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
</output-format>`;

const FEEDBACK_PROMPT = `
<feedback-instructions>
We also need to consider the errors from last attempt at query generation.

In the last attempt, these were the columns selected:
{lastColumns}

But it was rejected with the following errors:
{feedback}

Use these errors to refine your column selection. Consider if you need additional columns for joins, filtering, or calculations.
</feedback-instructions>
`;

export type GetColumnsStepDeps = {
  llm: LLMProvider;
  schemaHelper: DbSchemaHelperService;
  config: DbQueryConfig;
  checks?: string[];
};

/**
 * Selects the minimal set of columns needed to answer the user's query.
 * Implements the same three-attempt retry loop as the LangGraph version,
 * validating that all returned column names exist in the schema.
 */
export async function getColumnsStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: GetColumnsStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {tables: Object.keys(state.schema?.tables ?? {})});

  if (!deps.config.columnSelection) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: 'Skipping column selection as per configuration',
    });
    return {};
  }

  if (!state.schema?.tables || Object.keys(state.schema.tables).length === 0) {
    throw new Error(
      'No tables found in the schema. Please ensure the get-tables step was completed successfully.',
    );
  }

  const tablesWithColumns = getTablesWithColumns(state.schema);

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Selecting relevant columns from ${Object.keys(state.schema.tables).length} tables`,
  });
  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Extracting relevant columns from the schema'},
  });

  const feedbacksText = buildFeedbacks(state);
  const content = buildPrompt(GET_COLUMNS_PROMPT, {
    tablesWithColumns: tablesWithColumns.join('\n\n'),
    query: state.prompt,
    feedbacks: feedbacksText,
    checks: [
      '<must-follow-rules>',
      ...(deps.checks ?? []),
      ...deps.schemaHelper.getTablesContext(state.schema),
      '</must-follow-rules>',
    ].join('\n'),
  });

  let attempts = 0;
  let selectedColumns: Record<string, string[]> = {};

  while (attempts < 3) {
    attempts++;
    debug('column selection attempt %d', attempts);

    const {text, usage} = await generateText({
      model: deps.llm,
      messages: [{role: 'user', content}],
    });
    context.onUsage?.(
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      'unknown',
    );
    debug('token usage captured attempt=%d', attempts, {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
    });

    const output = stripThinkingFromText(text);

    if (output.startsWith('failed attempt:')) {
      context.writer?.({
        type: LLMStreamEventType.Log,
        data: `Column selection failed: ${output}`,
      });
      return {
        status: GenerationError.Failed,
        replyToUser: output.replace('failed attempt: ', ''),
      };
    }

    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        context.writer?.({
          type: LLMStreamEventType.Log,
          data: `Failed to find JSON in LLM response, trying again (attempt ${attempts})`,
        });
        continue;
      }

      selectedColumns = JSON.parse(jsonMatch[0]);

      if (validateColumns(selectedColumns, state.schema)) {
        break;
      } else {
        context.writer?.({
          type: LLMStreamEventType.Log,
          data: `LLM returned invalid columns (attempt ${attempts})`,
        });
      }
    } catch {
      context.writer?.({
        type: LLMStreamEventType.Log,
        data: `Failed to parse JSON response (attempt ${attempts})`,
      });
    }
  }

  if (Object.keys(selectedColumns).length === 0) {
    return {
      status: GenerationError.Failed,
      replyToUser:
        'Not able to select relevant columns. Please rephrase the question or provide more details.',
    };
  }

  const filteredSchema = createFilteredSchema(state.schema, selectedColumns);
  debug('step result columns=%o', selectedColumns);
  return {schema: filteredSchema};
}

function buildFeedbacks(state: DbQueryState): string {
  if (!state.feedbacks) return '';
  const lastColumns = getSelectedColumnsFromSchema(state.schema);
  return buildPrompt(FEEDBACK_PROMPT, {
    lastColumns: JSON.stringify(lastColumns, null, 2),
    feedback: state.feedbacks.join('\n'),
  });
}

function getTablesWithColumns(schema: DatabaseSchema): string[] {
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

function validateColumns(
  selectedColumns: Record<string, string[]>,
  schema: DatabaseSchema,
): boolean {
  for (const tableName of Object.keys(selectedColumns)) {
    if (!schema.tables[tableName]) return false;
    const tableColumns = Object.keys(schema.tables[tableName].columns);
    for (const columnName of selectedColumns[tableName]) {
      if (!tableColumns.includes(columnName)) return false;
    }
  }
  return true;
}

function createFilteredSchema(
  originalSchema: DatabaseSchema,
  selectedColumns: Record<string, string[]>,
): DatabaseSchema {
  const filteredTables: Record<string, TableSchema> = {};

  for (const [tableName, columnNames] of Object.entries(selectedColumns)) {
    if (originalSchema.tables[tableName]) {
      const originalTable = originalSchema.tables[tableName];
      const filteredColumns: Record<string, ColumnSchema> = {};

      for (const columnName of columnNames) {
        if (originalTable.columns[columnName]) {
          filteredColumns[columnName] = originalTable.columns[columnName];
        }
      }

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

  const filteredRelations = originalSchema.relations.filter(
    relation =>
      filteredTables[relation.table] &&
      filteredTables[relation.referencedTable],
  );

  return {tables: filteredTables, relations: filteredRelations};
}

function getSelectedColumnsFromSchema(
  schema: DatabaseSchema,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [tableName, table] of Object.entries(schema.tables)) {
    result[tableName] = Object.keys(table.columns);
  }
  return result;
}

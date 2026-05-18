import {createStep} from '@mastra/core/workflows';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const COLUMN_SELECTION_PROMPT = `
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

const COLUMN_FEEDBACK_PROMPT = `
<feedback-instructions>
We also need to consider the errors from last attempt at query generation.

In the last attempt, these were the columns selected:
{lastColumns}

But it was rejected with the following errors:
{feedback}

Use these errors to refine your column selection. Consider if you need additional columns for joins, filtering, or calculations.
</feedback-instructions>
`;

/**
 * ColumnSelectionStep — replaces GetColumnsNode.
 *
 * Selects relevant columns from the chosen tables to reduce schema
 * complexity for SQL generation. Includes a 3-attempt internal retry loop.
 */
export const columnSelectionStep = createStep({
  id: 'column-selection',
  inputSchema: z.object({
    prompt: z.string(),
    schema: DatabaseSchemaZ,
    feedbacks: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    schema: DatabaseSchemaZ,
    status: z.string().optional(),
    replyToUser: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaHelper = ctx.get('schemaHelper');
    const globalContext = ctx.get('globalContext');
    const schema = inputData.schema as DatabaseSchema;

    if (!dbQueryConfig.columnSelection) {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: 'Skipping column selection as per configuration',
      });
      return {schema: inputData.schema};
    }

    if (!schema?.tables || Object.keys(schema.tables).length === 0) {
      throw new Error(
        'No tables found in the schema. Please ensure the get-tables step was completed successfully.',
      );
    }

    const tablesWithColumns = getTablesWithColumns(schema);

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Selecting relevant columns from ${Object.keys(schema.tables).length} tables`,
    });

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Extracting relevant columns from the schema'},
    });

    const feedbacksText = buildColumnFeedbackText(inputData.feedbacks, schema);

    const checks = [
      '<must-follow-rules>',
      ...(globalContext ?? []),
      ...schemaHelper.getTablesContext(schema),
      '</must-follow-rules>',
    ].join('\n');

    const selectionResult = await selectColumnsWithRetries({
      llm: cheapLlm,
      prompt: inputData.prompt,
      tablesWithColumns,
      feedbacksText,
      checks,
      schema,
      writer,
      maxAttempts: 3,
    });

    if (selectionResult.status === 'failed') {
      return {
        schema: inputData.schema,
        status: 'failed',
        replyToUser: selectionResult.replyToUser,
      };
    }

    const selectedColumns = selectionResult.columns;

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Selected columns: ${JSON.stringify(selectedColumns, null, 2)}`,
    });

    const filteredSchema = createFilteredSchema(schema, selectedColumns);
    return {schema: filteredSchema};
  },
});

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
  const filteredTables: DatabaseSchema['tables'] = {};

  for (const [tableName, columnNames] of Object.entries(selectedColumns)) {
    if (originalSchema.tables[tableName]) {
      const originalTable = originalSchema.tables[tableName];
      const filteredColumns: Record<
        string,
        (typeof originalTable.columns)[string]
      > = {};

      for (const columnName of columnNames) {
        if (originalTable.columns[columnName]) {
          filteredColumns[columnName] = originalTable.columns[columnName];
        }
      }

      // Always include primary key columns
      for (const pkColumn of originalTable.primaryKey) {
        if (!filteredColumns[pkColumn] && originalTable.columns[pkColumn]) {
          filteredColumns[pkColumn] = originalTable.columns[pkColumn];
        }
      }

      filteredTables[tableName] = {...originalTable, columns: filteredColumns};
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

function buildColumnFeedbackText(
  feedbacks: string[] | undefined,
  schema: DatabaseSchema,
): string {
  if (!feedbacks?.length) {
    return '';
  }
  return COLUMN_FEEDBACK_PROMPT.replace(
    '{lastColumns}',
    JSON.stringify(getSelectedColumnsFromSchema(schema), null, 2),
  ).replace('{feedback}', feedbacks.join('\n'));
}

function parseSelectedColumns(
  output: string,
):
  | {status: 'failed'; reason: string}
  | {status: 'retry'}
  | {status: 'success'; columns: Record<string, string[]>} {
  if (output.startsWith('failed attempt:')) {
    return {
      status: 'failed',
      reason: output.replace('failed attempt: ', ''),
    };
  }

  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {status: 'retry'};
  }

  return {
    status: 'success',
    columns: JSON.parse(jsonMatch[0]) as Record<string, string[]>,
  };
}

async function selectColumnsWithRetries(params: {
  llm: MastraLanguageModel;
  prompt: string;
  tablesWithColumns: string[];
  feedbacksText: string;
  checks: string;
  schema: DatabaseSchema;
  writer: {
    write: (event: {
      type: LLMStreamEventType;
      data: string | {status: string};
    }) => Promise<void>;
  };
  maxAttempts: number;
}): Promise<
  | {status: 'failed'; replyToUser: string}
  | {status: 'success'; columns: Record<string, string[]>}
> {
  let attempts = 0;
  while (attempts < params.maxAttempts) {
    attempts++;
    const prompt = COLUMN_SELECTION_PROMPT.replace(
      '{tablesWithColumns}',
      params.tablesWithColumns.join('\n\n'),
    )
      .replace('{query}', params.prompt)
      .replace('{feedbacks}', params.feedbacksText)
      .replace('{checks}', params.checks);

    const rawResult = await invokeLlm(params.llm, prompt);
    const output = stripThinkingTokens(rawResult);

    try {
      const parsed = parseSelectedColumns(output);

      if (parsed.status === 'failed') {
        await params.writer.write({
          type: LLMStreamEventType.Log,
          data: `Column selection failed: ${output}`,
        });
        return {status: 'failed', replyToUser: parsed.reason};
      }

      if (parsed.status === 'retry') {
        await params.writer.write({
          type: LLMStreamEventType.Log,
          data: `Failed to find JSON in LLM response, trying again (attempt ${attempts})`,
        });
        continue;
      }

      if (validateColumns(parsed.columns, params.schema)) {
        return {status: 'success', columns: parsed.columns};
      }

      if (attempts === params.maxAttempts) {
        return {
          status: 'failed',
          replyToUser:
            'Not able to select relevant columns from the schema. Please rephrase the question or provide more details.',
        };
      }

      await params.writer.write({
        type: LLMStreamEventType.Log,
        data: `LLM returned invalid columns, trying again (attempt ${attempts})`,
      });
    } catch (error) {
      if (attempts === params.maxAttempts) {
        return {
          status: 'failed',
          replyToUser:
            'Failed to parse column selection response. Please try again.',
        };
      }

      await params.writer.write({
        type: LLMStreamEventType.Log,
        data: `Failed to parse LLM response: ${error}, trying again (attempt ${attempts})`,
      });
    }
  }

  return {
    status: 'failed',
    replyToUser: 'Failed to parse column selection response. Please try again.',
  };
}

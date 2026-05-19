import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens, stripCodeBlock} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const FIX_QUERY_PROMPT = `
<instructions>
You are an expert AI assistant that fixes SQL query errors.
You are given a SQL query that has validation errors related to specific tables.
Your task is to fix ONLY the parts of the query related to the listed error tables.
DO NOT change any part of the query that does not involve the error tables.
Preserve the overall structure, logic, and all other table references exactly as they are.

Rules:
- Only modify clauses, joins, columns, or conditions that involve the error tables.
- Do not add, remove, or reorder columns or tables that are not related to the error.
- Do not change aliases, formatting, or logic for unrelated parts of the query.
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Use the provided schema for the error-related tables to write correct SQL.
- The dialect is {dialect}.
</instructions>

<user-question>
{question}
</user-question>

<current-query>
{currentQuery}
</current-query>

<error-tables-schema>
{errorSchema}
</error-tables-schema>

<error-details>
{errorFeedback}
</error-details>

{checks}

{historicalErrors}

<output-instructions>
Output should only be a valid SQL query with no other special character or formatting.
Contains the required valid SQL with the error fixed.
It should have no other character or symbol or character that is not part of SQLs.
</output-instructions>`;

/**
 * QueryRepairStep — replaces FixQueryNode.
 *
 * Fixes SQL errors by providing the LLM with just the error-related
 * table schemas and asking it to fix only those parts.
 */
export const queryRepairStep = createStep({
  id: 'query-repair',
  inputSchema: z.object({
    prompt: z.string(),
    sql: z.string(),
    schema: DatabaseSchemaZ,
    feedbacks: z.array(z.string()).optional(),
    syntacticErrorTables: z.array(z.string()).optional(),
    semanticErrorTables: z.array(z.string()).optional(),
    validationChecklist: z.string().optional(),
  }),
  outputSchema: z.object({
    sql: z.string().optional(),
    status: z.string().optional(),
    replyToUser: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaHelper = ctx.get('schemaHelper');
    const schema = inputData.schema as DatabaseSchema;

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Fixing SQL query based on validation errors'},
    });
    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Fixing SQL query based on validation errors',
    });

    const errorTables = [
      ...(inputData.syntacticErrorTables ?? []),
      ...(inputData.semanticErrorTables ?? []),
    ];

    const trimmedSchema = trimSchema(schema, errorTables);
    const errorSchemaString = schemaHelper.asString(trimmedSchema);

    const feedbacks = inputData.feedbacks ?? [];
    const lastFeedback = feedbacks[feedbacks.length - 1] ?? '';
    const historicalErrors = feedbacks.slice(0, -1);

    const checks = buildChecks(inputData, trimmedSchema, schemaHelper);
    const dialect = dbQueryConfig.db?.dialect ?? 'PostgreSQL';

    const prompt = FIX_QUERY_PROMPT.replace('{dialect}', dialect)
      .replace('{question}', inputData.prompt)
      .replace('{currentQuery}', inputData.sql)
      .replace('{errorSchema}', errorSchemaString)
      .replace('{errorFeedback}', lastFeedback)
      .replace('{checks}', checks)
      .replace(
        '{historicalErrors}',
        historicalErrors.length
          ? [
              '<historical-errors>',
              'You already faced following issues in the past -',
              historicalErrors.join('\n'),
              '</historical-errors>',
            ].join('\n')
          : '',
      );

    const rawOutput = await invokeLlm(cheapLlm, prompt);
    const response = stripThinkingTokens(rawOutput);
    const sql = stripCodeBlock(response) || undefined;

    if (!sql) {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: `SQL fix failed: ${response}`,
      });
      return {
        status: 'failed',
        replyToUser:
          'Failed to fix SQL query. Please try rephrasing your question or provide more details.',
      };
    }

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Fixed SQL query: ${sql}`,
    });

    return {sql, status: 'pass'};
  },
});

function trimSchema(
  fullSchema: DatabaseSchema,
  errorTables: string[],
): DatabaseSchema {
  const errorTableSet = new Set(errorTables);
  const trimmedTables: DatabaseSchema['tables'] = {};

  for (const tableName of Object.keys(fullSchema.tables)) {
    if (errorTableSet.has(tableName)) {
      trimmedTables[tableName] = fullSchema.tables[tableName];
    }
  }

  const trimmedRelations = fullSchema.relations.filter(
    rel =>
      errorTableSet.has(rel.table) || errorTableSet.has(rel.referencedTable),
  );

  return {tables: trimmedTables, relations: trimmedRelations};
}

function buildChecks(
  inputData: {validationChecklist?: string},
  trimmedSchema: DatabaseSchema,
  schemaHelper: {getTablesContext(schema: DatabaseSchema): string[]},
): string {
  if (inputData.validationChecklist) {
    return [
      '<must-follow-rules>',
      'You must keep these additional details in mind while fixing the query -',
      ...inputData.validationChecklist.split('\n').map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n');
  }
  const context = schemaHelper.getTablesContext(trimmedSchema);
  if (context.length === 0) return '';
  return [
    '<must-follow-rules>',
    'You must keep these additional details in mind while fixing the query -',
    ...context.map(check => `- ${check}`),
    '</must-follow-rules>',
  ].join('\n');
}

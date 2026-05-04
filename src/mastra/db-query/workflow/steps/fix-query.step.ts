import {generateText} from 'ai';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  DatabaseSchema,
  DbQueryConfig,
  EvaluationResult,
  GenerationError,
} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider, SupportedDBs} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')('ai-integration:mastra:db-query:fix-query');

const FIX_PROMPT = `
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

export type FixQueryStepDeps = {
  llm: LLMProvider;
  config: DbQueryConfig;
  schemaHelper: DbSchemaHelperService;
};

/**
 * Repairs the SQL query based on validation error feedback, targeting only the
 * tables identified as problematic. Uses a trimmed schema (error tables only)
 * to guide the fix.
 */
export async function fixQueryStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: FixQueryStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {sql: state.sql, feedbacks: state.feedbacks?.length});

  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Fixing SQL query based on validation errors'},
  });

  const errorTables = [
    ...(state.syntacticErrorTables ?? []),
    ...(state.semanticErrorTables ?? []),
  ];

  const trimmedSchema =
    errorTables.length > 0
      ? trimSchema(state.schema, errorTables)
      : state.schema;

  const lastFeedback = state.feedbacks?.length
    ? state.feedbacks[state.feedbacks.length - 1]
    : 'Unknown validation error';

  const historicalFeedbacks = state.feedbacks?.slice(0, -1) ?? [];

  const content = buildPrompt(FIX_PROMPT, {
    dialect: deps.config.db?.dialect ?? SupportedDBs.PostgreSQL,
    question: state.prompt,
    currentQuery: state.sql ?? '',
    errorSchema: deps.schemaHelper.asString(trimmedSchema),
    errorFeedback: lastFeedback,
    checks: buildChecks(state, trimmedSchema, deps),
    historicalErrors: historicalFeedbacks.length
      ? [
          '<historical-errors>',
          'You also faced these issues in previous attempts -',
          historicalFeedbacks.join('\n'),
          '</historical-errors>',
        ].join('\n')
      : '',
  });

  debug('invoking LLM to fix query');
  const {text, usage} = await generateText({
    model: deps.llm,
    messages: [{role: 'user', content}],
  });
  context.onUsage?.(usage.inputTokens ?? 0, usage.outputTokens ?? 0, 'unknown');
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });

  const response = stripThinkingFromText(text);
  const sql =
    response
      .replace(/^```(?:sql)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim() || undefined;

  if (!sql) {
    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `SQL fix failed: ${response}`,
    });
    return {
      status: GenerationError.Failed,
      replyToUser:
        'Failed to fix SQL query. Please try rephrasing your question or provide more details.',
    };
  }

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Fixed SQL query: ${sql}`,
  });

  const result = {status: EvaluationResult.Pass, sql};
  debug('step result', {sql});
  return result;
}

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
  state: DbQueryState,
  trimmedSchema: DatabaseSchema,
  deps: FixQueryStepDeps,
): string {
  if (state.validationChecklist) {
    return [
      '<must-follow-rules>',
      'You must keep these additional details in mind while fixing the query -',
      ...state.validationChecklist.split('\n').map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n');
  }
  const context = deps.schemaHelper.getTablesContext(trimmedSchema);
  if (context.length === 0) return '';
  return [
    '<must-follow-rules>',
    'You must keep these additional details in mind while fixing the query -',
    ...context.map(check => `- ${check}`),
    '</must-follow-rules>',
  ].join('\n');
}

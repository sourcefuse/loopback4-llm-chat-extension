import {generateText} from 'ai';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  ChangeType,
  DbQueryConfig,
  EvaluationResult,
  GenerationError,
} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider, SupportedDBs} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')('ai-integration:mastra:db-query:sql-generation');

const SQL_GENERATION_PROMPT = `
<instructions>
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a {dialect} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.
- Do not make any assumptions about the user's intent beyond what is explicitly provided in the prompt.
- Ensure proper grouping with brackets for where clauses with multiple conditions using AND and OR.
- Follow each and every single rule in the "must-follow-rules" section carefully while writing the query. DO NOT SKIP ANY RULE.
</instructions>
<user-question>
{question}
</user-question>
<context>
<database-schema>
{dbschema}
</database-schema>

{checks}

{exampleQueries}

{feedbacks}
</context>
<output-instructions>
{outputFormat}
</output-instructions>`;

const OUTPUT_FORMAT = `
Output should only be a valid SQL query with no other special character or formatting.
Contains the required valid SQL satisfying all the constraints.
It should have no other character or symbol or character that is not part of SQLs.`;

const FEEDBACK_PROMPT = `
<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.
Make sure you fix the provided error without introducing any new or past errors.
In the last attempt, you generated this SQL query -
<last-generated-query>
{query}
</last-generated-query>

<last-error>
{feedback}
</last-error>

{historicalErrors}
</feedback-instructions>`;

export type SqlGenerationStepDeps = {
  sqlLLM: LLMProvider;
  cheapLLM: LLMProvider;
  config: DbQueryConfig;
  schemaHelper: DbSchemaHelperService;
  checks?: string[];
};

/**
 * Selects cheap vs. smart LLM based on query complexity (minor change, single
 * table, or validation-fix retry → cheap LLM; otherwise → smart LLM).
 * Generates a SQL query from the filtered schema and state context.
 */
export async function sqlGenerationStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: SqlGenerationStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {
    prompt: state.prompt,
    feedbacks: state.feedbacks?.length,
  });

  const isSingleTable =
    state.schema.tables && Object.keys(state.schema.tables).length === 1;
  const isValidationFixRetry =
    state.feedbacks?.length &&
    state.feedbacks[state.feedbacks.length - 1].startsWith(
      'Query Validation Failed',
    );

  const llm =
    state.changeType === ChangeType.Minor ||
    isSingleTable ||
    isValidationFixRetry
      ? deps.cheapLLM
      : deps.sqlLLM;

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Generating SQL query from the prompt - ${state.prompt}`,
  });
  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Generating SQL query from the prompt'},
  });

  const content = buildPrompt(SQL_GENERATION_PROMPT, {
    dialect: deps.config.db?.dialect ?? SupportedDBs.PostgreSQL,
    question: state.prompt,
    dbschema: deps.schemaHelper.asString(state.schema),
    checks: buildChecks(state, deps),
    feedbacks: buildFeedbacks(state),
    exampleQueries: state.feedbacks?.length ? '' : buildSampleQueries(state),
    outputFormat: OUTPUT_FORMAT,
  });

  debug('generating SQL');
  const {text, usage} = await generateText({
    model: llm,
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
      data: `SQL generation failed: ${response}`,
    });
    return {
      status: GenerationError.Failed,
      replyToUser:
        'Failed to generate SQL query. Please try rephrasing your question or provide more details.',
    };
  }

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Generated SQL query: ${sql}`,
  });

  const result = {status: EvaluationResult.Pass, sql};
  debug('step result', {sql});
  return result;
}

function buildFeedbacks(state: DbQueryState): string {
  if (!state.feedbacks?.length) return '';
  const lastFeedback = state.feedbacks[state.feedbacks.length - 1];
  const otherFeedbacks = state.feedbacks.slice(0, -1);
  return buildPrompt(FEEDBACK_PROMPT, {
    query: state.sql ?? '',
    feedback: `This was the error in the latest query you generated - \n${lastFeedback}`,
    historicalErrors: otherFeedbacks.length
      ? [
          '<historical-feedbacks>',
          'You already faced following issues in the past -',
          otherFeedbacks.join('\n'),
          '</historical-feedbacks>',
        ].join('\n')
      : '',
  });
}

function buildSampleQueries(state: DbQueryState): string {
  let startTag = '<similar-example-query>';
  let endTag = '</similar-example-query>';
  let baseLine =
    'Here is an example query for reference that is similar to the question asked and has been validated by the user';
  if (!state.fromCache) {
    startTag = '<last-generated-query>';
    endTag = '</last-generated-query>';
    baseLine =
      'Here is the last valid SQL query that was generated for the user that is supposed to be used as the base line for the next query generation.';
  }
  return state.sampleSql
    ? `${startTag}\n${baseLine} -\n${state.sampleSql}\nThis was generated for the following question - \n${state.sampleSqlPrompt} \n\n${endTag}`
    : '';
}

function buildChecks(state: DbQueryState, deps: SqlGenerationStepDeps): string {
  if (state.validationChecklist) {
    return [
      '<must-follow-rules>',
      'You must keep these additional details in mind while writing the query -',
      ...state.validationChecklist.split('\n').map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n');
  }
  return [
    '<must-follow-rules>',
    'You must keep these additional details in mind while writing the query -',
    ...(deps.checks ?? []).map(check => `- ${check}`),
    ...deps.schemaHelper
      .getTablesContext(state.schema)
      .map(check => `- ${check}`),
    '</must-follow-rules>',
  ].join('\n');
}

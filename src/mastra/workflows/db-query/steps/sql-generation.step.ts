import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens, stripCodeBlock} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

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
Output should only be a valid SQL query with no other special character or formatting.
Contains the required valid SQL satisfying all the constraints.
It should have no other character or symbol or character that is not part of SQLs.
</output-instructions>`;

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

/**
 * SqlGenerationStep — replaces SqlGenerationNode.
 *
 * Generates SQL from the user prompt and filtered schema.
 * Selects cheap vs smart LLM based on changeType, table count, and retry status.
 */
export const sqlGenerationStep = createStep({
  id: 'sql-generation',
  inputSchema: z.object({
    prompt: z.string(),
    schema: DatabaseSchemaZ,
    changeType: z.enum(['minor', 'major', 'rewrite']).optional(),
    sampleSql: z.string().optional(),
    sampleSqlPrompt: z.string().optional(),
    fromCache: z.boolean().optional(),
    validationChecklist: z.string().optional(),
    feedbacks: z.array(z.string()).optional(),
    sql: z.string().optional(),
  }),
  outputSchema: z.object({
    sql: z.string().optional(),
    status: z.string().optional(),
    replyToUser: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const smartLlm = ctx.get('smartLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaHelper = ctx.get('schemaHelper');
    const globalContext = ctx.get('globalContext');
    const schema = inputData.schema as DatabaseSchema;

    const isSingleTable =
      schema?.tables && Object.keys(schema.tables).length === 1;

    // Use cheap LLM for validation fix retries
    const isValidationFixRetry =
      inputData.feedbacks?.length &&
      inputData.feedbacks[inputData.feedbacks.length - 1].startsWith(
        'Query Validation Failed',
      );

    const llm =
      inputData.changeType === 'minor' || isSingleTable || isValidationFixRetry
        ? cheapLlm
        : smartLlm;

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Generating SQL query from the prompt - ${inputData.prompt}`,
    });
    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Generating SQL query from the prompt'},
    });

    const feedbacksText = buildFeedbacks(inputData);
    const exampleQueries = inputData.feedbacks?.length
      ? ''
      : buildSampleQueries(inputData);
    const checks = buildChecks(inputData, schema, schemaHelper, globalContext);

    const dialect = dbQueryConfig.db?.dialect ?? 'PostgreSQL';

    const prompt = SQL_GENERATION_PROMPT.replace('{dialect}', dialect)
      .replace('{question}', inputData.prompt)
      .replace('{dbschema}', schemaHelper.asString(schema))
      .replace('{checks}', checks)
      .replace('{exampleQueries}', exampleQueries)
      .replace('{feedbacks}', feedbacksText);

    const rawOutput = await invokeLlm(llm, prompt);
    const response = stripThinkingTokens(rawOutput);
    const sql = stripCodeBlock(response) || undefined;

    if (!sql) {
      await writer.write({
        type: LLMStreamEventType.Log,
        data: `SQL generation failed: ${response}`,
      });
      return {
        status: 'failed',
        replyToUser:
          'Failed to generate SQL query. Please try rephrasing your question or provide more details.',
      };
    }

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Generated SQL query: ${sql}`,
    });

    return {sql, status: 'pass'};
  },
});

function buildFeedbacks(inputData: {
  feedbacks?: string[];
  sql?: string;
}): string {
  if (!inputData.feedbacks?.length) return '';
  const lastFeedback = inputData.feedbacks[inputData.feedbacks.length - 1];
  const otherFeedbacks = inputData.feedbacks.slice(0, -1);
  return FEEDBACK_PROMPT.replace('{query}', inputData.sql ?? '')
    .replace(
      '{feedback}',
      `This was the error in the latest query you generated - \n${lastFeedback}`,
    )
    .replace(
      '{historicalErrors}',
      otherFeedbacks.length
        ? [
            '<historical-feedbacks>',
            'You already faced following issues in the past -',
            otherFeedbacks.join('\n'),
            '</historical-feedbacks>',
          ].join('\n')
        : '',
    );
}

function buildSampleQueries(inputData: {
  sampleSql?: string;
  sampleSqlPrompt?: string;
  fromCache?: boolean;
}): string {
  if (!inputData.sampleSql) return '';
  const startTag = inputData.fromCache
    ? '<similar-example-query>'
    : '<last-generated-query>';
  const endTag = inputData.fromCache
    ? '</similar-example-query>'
    : '</last-generated-query>';
  const baseLine = inputData.fromCache
    ? 'Here is an example query for reference that is similar to the question asked and has been validated by the user'
    : 'Here is the last valid SQL query that was generated for the user that is supposed to be used as the base line for the next query generation.';
  return `${startTag}\n${baseLine} -\n${inputData.sampleSql}\nThis was generated for the following question - \n${inputData.sampleSqlPrompt}\n${endTag}`;
}

function buildChecks(
  inputData: {validationChecklist?: string},
  schema: DatabaseSchema,
  schemaHelper: {getTablesContext(schema: DatabaseSchema): string[]},
  globalContext: string[],
): string {
  if (inputData.validationChecklist) {
    return [
      '<must-follow-rules>',
      'You must keep these additional details in mind while writing the query -',
      ...inputData.validationChecklist.split('\n').map(check => `- ${check}`),
      '</must-follow-rules>',
    ].join('\n');
  }
  return [
    '<must-follow-rules>',
    'You must keep these additional details in mind while writing the query -',
    ...(globalContext ?? []).map(check => `- ${check}`),
    ...schemaHelper.getTablesContext(schema).map(check => `- ${check}`),
    '</must-follow-rules>',
  ].join('\n');
}

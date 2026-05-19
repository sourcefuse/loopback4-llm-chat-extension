import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const DESCRIPTION_PROMPT = `
<instructions>
You are an AI assistant that describes what a SQL query does in plain english.
Analyze the actual query below and write a concise, bulleted summary of the data it retrieves and any filters/conditions it applies.
Write in plain english. No SQL, no technical jargon, no table/column names.
</instructions>

<user-question>
{prompt}
</user-question>

<sql-query>
{sql}
</sql-query>

<database-schema>
{schema}
</database-schema>

{checks}

<output-instructions>
Return a short bulleted list where each bullet is one condition, filter, or piece of data the query retrieves.
- Use plain, non-technical language a business user would understand.
- Do NOT mention tables, columns, joins, CTEs, enums, or any DB concepts.
- Keep each bullet to one line.
- Do not add any preamble, heading, or closing text — just the bullets.
</output-instructions>`;

/**
 * DescriptionGenerationStep — replaces GenerateDescriptionNode.
 *
 * Generates a plain-language description of the SQL query.
 * Emits tokens as ToolStatus for frontend streaming.
 */
export const descriptionGenerationStep = createStep({
  id: 'description-generation',
  inputSchema: z.object({
    prompt: z.string(),
    sql: z.string().optional(),
    schema: DatabaseSchemaZ,
  }),
  outputSchema: z.object({
    description: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaHelper = ctx.get('schemaHelper');
    const globalContext = ctx.get('globalContext');
    const schema = inputData.schema as DatabaseSchema;

    const generateDesc =
      dbQueryConfig.nodes?.sqlGenerationNode?.generateDescription !== false;

    if (!generateDesc || !inputData.sql) {
      return {};
    }

    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Generating query description.',
    });

    const checks = [
      '<must-follow-rules>',
      ...(globalContext ?? []),
      ...schemaHelper.getTablesContext(schema),
      '</must-follow-rules>',
    ].join('\n');

    const prompt = DESCRIPTION_PROMPT.replace('{prompt}', inputData.prompt)
      .replace('{sql}', inputData.sql)
      .replace('{schema}', schemaHelper.asString(schema))
      .replace('{checks}', checks);

    const rawOutput = await invokeLlm(cheapLlm, prompt);
    const description = stripThinkingTokens(rawOutput);

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Query description: ${description}`,
    });

    return {description};
  },
});

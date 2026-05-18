import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const SYNTACTIC_ERROR_PROMPT = `You are an AI assistant that categorizes the SQL query error and identifies related tables.

Here is the SQL query error that you need to categorize -
{error}

Here is the query that resulted in the error -
{query}

Here are all the available tables in the database -
{tableNames}

Categorize the error into one of these two categories:
- table_not_found: Any error that indicates a table or column is missing
- query_error: All other errors

Also identify ALL tables that are related to the error. Be generous - include tables that are directly involved in the error, tables referenced in the failing part of the query, and tables that might need to be joined or referenced to fix the error. It is better to include extra tables than to miss any.

Return your response in exactly this format with no other text:
<category>table_not_found or query_error</category>
<tables>comma, separated, table, names</tables>
`;

/**
 * SyntacticValidationStep — replaces SyntacticValidatorNode.
 *
 * Validates SQL by executing it against the database connector (EXPLAIN/dry-run).
 * If it fails, classifies the error type and identifies related tables.
 */
export const syntacticValidationStep = createStep({
  id: 'syntactic-validation',
  inputSchema: z.object({
    sql: z.string(),
    schema: DatabaseSchemaZ,
  }),
  outputSchema: z.object({
    syntacticStatus: z.string(),
    syntacticFeedback: z.string().optional(),
    syntacticErrorTables: z.array(z.string()).optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const connector = ctx.get('connector');

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {status: 'Validating generated SQL query'},
    });
    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Validating the query syntactically.',
    });

    try {
      if (!inputData.sql) {
        throw new Error('No SQL query generated to validate');
      }
      await connector.validate(inputData.sql);
      return {syntacticStatus: 'pass'};
    } catch (error) {
      const tableNames = Object.keys(inputData.schema.tables);
      const errorMessage = (error as Error).message;

      const prompt = SYNTACTIC_ERROR_PROMPT.replace('{error}', errorMessage)
        .replace('{query}', inputData.sql)
        .replace('{tableNames}', tableNames.join(', '));

      const rawOutput = await invokeLlm(cheapLlm, prompt);
      const result = stripThinkingTokens(rawOutput);

      const categoryMatch = /<category>(.*?)<\/category>/s.exec(result);
      const tablesMatch = /<tables>(.*?)<\/tables>/s.exec(result);

      const category = categoryMatch ? categoryMatch[1].trim() : 'query_error';
      const errorTables = tablesMatch
        ? tablesMatch[1]
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        : [];

      await writer.write({
        type: LLMStreamEventType.Log,
        data: `Query Validation Failed by DB: ${category} with error ${errorMessage}`,
      });

      return {
        syntacticStatus: category,
        syntacticFeedback: `Query Validation Failed by DB: ${category} with error ${errorMessage}`,
        syntacticErrorTables: errorTables,
      };
    }
  },
});

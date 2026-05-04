import {generateText} from 'ai';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  EvaluationResult,
  IDbConnector,
} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')(
  'ai-integration:mastra:db-query:syntactic-validator',
);

const CATEGORIZE_PROMPT = `You are an AI assistant that categorizes the SQL query error and identifies related tables.

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

export type SyntacticValidatorStepDeps = {
  llm: LLMProvider;
  connector: IDbConnector;
};

/**
 * Executes the SQL against the configured connector to catch database-level
 * syntax and schema errors. On failure, uses the LLM to categorize the error
 * and identify affected tables for the retry loop.
 */
export async function syntacticValidatorStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: SyntacticValidatorStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {sql: state.sql});

  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {status: 'Validating generated SQL query'},
  });
  context.writer?.({
    type: LLMStreamEventType.Log,
    data: 'Validating the query syntactically.',
  });

  try {
    if (!state.sql) throw new Error('No SQL query generated to validate');
    await deps.connector.validate(state.sql);
    debug('syntactic validation passed');
    return {syntacticStatus: EvaluationResult.Pass};
  } catch (error) {
    debug('syntactic validation failed: %s', (error as Error).message);

    const tableNames = Object.keys(state.schema?.tables ?? {});
    const content = buildPrompt(CATEGORIZE_PROMPT, {
      error: (error as Error).message,
      query: state.sql ?? '',
      tableNames: tableNames.join(', '),
    });

    const {text, usage} = await generateText({
      model: deps.llm,
      messages: [{role: 'user', content}],
    });
    context.onUsage?.(
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      'unknown',
    );
    debug('token usage captured', {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
    });

    const result = stripThinkingFromText(text);
    const categoryMatch = /<category>(.*?)<\/category>/s.exec(result);
    const tablesMatch = /<tables>(.*?)<\/tables>/s.exec(result);

    const category = categoryMatch
      ? (categoryMatch[1].trim() as EvaluationResult)
      : (result.trim() as EvaluationResult);

    const errorTables = tablesMatch
      ? tablesMatch[1]
          .split(',')
          .map(t => t.trim())
          .filter(t => t.length > 0)
      : [];

    context.writer?.({
      type: LLMStreamEventType.Log,
      data: `Query Validation Failed by DB: ${category} with error ${(error as Error).message}`,
    });

    const stepResult = {
      syntacticStatus: category,
      syntacticFeedback: `Query Validation Failed by DB: ${category} with error ${(error as Error).message}`,
      syntacticErrorTables: errorTables,
    };
    debug('step result', stepResult);
    return stepResult;
  }
}

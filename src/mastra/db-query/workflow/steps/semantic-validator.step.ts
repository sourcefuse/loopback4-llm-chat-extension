import {generateText} from 'ai';
import {
  DbSchemaHelperService,
  PermissionHelper,
} from '../../../../components/db-query/services';
import {TableSearchService} from '../../../../components/db-query/services/search/table-search.service';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  DbQueryConfig,
  EvaluationResult,
} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')(
  'ai-integration:mastra:db-query:semantic-validator',
);

const SEMANTIC_PROMPT = `
<instructions>
You are an AI assistant that validates whether a SQL query satisfies a given checklist.
The query has already been validated for syntax and correctness.
Go through each checklist item and verify it against the SQL query.
DO NOT make up issues that do not exist in the query.
</instructions>

<user-question>
{userPrompt}
</user-question>

<sql-query>
{query}
</sql-query>

<database-schema>
{schema}
</database-schema>

<available-tables>
{tableNames}
</available-tables>

<validation-checklist>
{checklist}
</validation-checklist>

{feedbacks}

<output-instructions>
If the query satisfies ALL checklist items, return ONLY a valid tag with no other text:
<example-valid>
<valid/>
</example-valid>

If any checklist item is NOT satisfied, return your response in two sections:
1. An invalid tag containing each failed item with a detailed explanation of what is wrong and how it should be fixed.
2. A tables tag listing ALL table names from the available tables that are related to the errors. Be generous - include tables directly involved in the error, tables that need to be joined to fix the issue, and any tables that could be relevant. It is better to include extra tables than to miss any.

<example-invalid>
<invalid>
- Salary values are not converted to USD. The query should join the exchange_rates table using currency_id and multiply salary by the rate.
- Lost and hold deals are not excluded. Add a WHERE condition to filter out deals with status 0 and 2.
</invalid>
<tables>exchange_rates, deals, employees</tables>
</example-invalid>
</output-instructions>
`;

const FEEDBACK_PROMPT = `
<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.

But was rejected by validator with the following errors -
{feedback}

Keep these feedbacks in mind while validating the new query.
</feedback-instructions>`;

export type SemanticValidatorStepDeps = {
  smartLlm: LLMProvider;
  cheapLlm: LLMProvider;
  config: DbQueryConfig;
  tableSearchService: TableSearchService;
  schemaHelper: DbSchemaHelperService;
  permissionHelper?: PermissionHelper;
};

/**
 * Validates the generated SQL against the validation checklist using the LLM.
 * Selects cheap vs. smart LLM based on config.
 */
export async function semanticValidatorStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: SemanticValidatorStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {sql: state.sql});

  context.writer?.({
    type: LLMStreamEventType.ToolStatus,
    data: {
      status: `Verifying if the query fully satisfies the user's requirement`,
    },
  });
  context.writer?.({
    type: LLMStreamEventType.Log,
    data: 'Validating the query semantically.',
  });

  const useSmartLLM =
    deps.config.nodes?.semanticValidatorNode?.useSmartLLM ?? false;
  const llm = useSmartLLM ? deps.smartLlm : deps.cheapLlm;

  const tableList =
    (await deps.tableSearchService.getTables(state.prompt)) ?? [];
  const accessibleTables = filterByPermissions(
    tableList,
    deps.permissionHelper,
  );

  const feedbacksText = state.feedbacks?.length
    ? buildPrompt(FEEDBACK_PROMPT, {feedback: state.feedbacks.join('\n')})
    : '';

  const content = buildPrompt(SEMANTIC_PROMPT, {
    userPrompt: state.prompt,
    query: state.sql ?? '',
    schema: deps.schemaHelper.asString(state.schema),
    tableNames: accessibleTables.join(', '),
    checklist: state.validationChecklist ?? 'No checklist provided.',
    feedbacks: feedbacksText,
  });

  debug('invoking LLM for semantic validation');
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
  const invalidMatch = /<invalid>(.*?)<\/invalid>/s.exec(response);
  const tablesMatch = /<tables>(.*?)<\/tables>/s.exec(response);
  const isValid =
    response.includes('<valid/>') || response.includes('<valid />');

  if (isValid && !invalidMatch) {
    debug('semantic validation passed');
    return {semanticStatus: EvaluationResult.Pass};
  }

  const reason = invalidMatch ? invalidMatch[1].trim() : response.trim();
  const errorTables = tablesMatch
    ? tablesMatch[1]
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0)
    : [];

  debug('semantic validation failed: %s', reason);
  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Query Validation Failed by LLM: ${reason}`,
  });

  const result = {
    semanticStatus: EvaluationResult.QueryError,
    semanticFeedback: `Query Validation Failed by LLM: ${reason}`,
    semanticErrorTables: errorTables,
  };
  debug('step result', result);
  return result;
}

function filterByPermissions(
  tables: string[],
  permissionHelper?: PermissionHelper,
): string[] {
  if (!permissionHelper) return tables;
  return tables.filter(t => {
    const name = t.toLowerCase().slice(t.indexOf('.') + 1);
    return permissionHelper.findMissingPermissions([name]).length === 0;
  });
}

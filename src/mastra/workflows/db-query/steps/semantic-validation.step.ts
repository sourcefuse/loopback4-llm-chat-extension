import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const SEMANTIC_VALIDATION_PROMPT = `
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

const SEMANTIC_FEEDBACK_PROMPT = `
<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.

But was rejected by validator with the following errors -
{feedback}

Keep these feedbacks in mind while validating the new query.
</feedback-instructions>`;

/**
 * SemanticValidationStep — replaces SemanticValidatorNode.
 *
 * Uses an LLM to validate the SQL against the filtered checklist.
 * Checks for logical correctness beyond syntax.
 */
export const semanticValidationStep = createStep({
  id: 'semantic-validation',
  inputSchema: z.object({
    prompt: z.string(),
    sql: z.string(),
    schema: DatabaseSchemaZ,
    validationChecklist: z.string().optional(),
    feedbacks: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    semanticStatus: z.string(),
    semanticFeedback: z.string().optional(),
    semanticErrorTables: z.array(z.string()).optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const smartLlm = ctx.get('smartLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const tableSearchService = ctx.get('tableSearchService');
    const schemaHelper = ctx.get('schemaHelper');
    const permissionHelper = ctx.get('permissionHelper');
    const schema = inputData.schema as DatabaseSchema;

    await writer.write({
      type: LLMStreamEventType.ToolStatus,
      data: {
        status: "Verifying if the query fully satisfies the user's requirement",
      },
    });
    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Validating the query semantically.',
    });

    const llm = selectSemanticValidationModel(
      dbQueryConfig.nodes?.semanticValidatorNode?.useSmartLLM ?? false,
      smartLlm,
      cheapLlm,
    );

    const tableList =
      (await tableSearchService.getTables(inputData.prompt)) ?? [];
    const accessibleTables = filterByPermissions(tableList, permissionHelper);

    const prompt = buildSemanticValidationPrompt({
      userPrompt: inputData.prompt,
      sql: inputData.sql,
      schema: schemaHelper.asString(schema),
      tableNames: accessibleTables,
      checklist: inputData.validationChecklist,
      feedbacks: inputData.feedbacks,
    });

    const rawOutput = await invokeLlm(llm, prompt);
    const response = stripThinkingTokens(rawOutput);

    const parsed = parseSemanticValidationResponse(response);
    if (parsed.isValid) {
      return {semanticStatus: 'pass'};
    }

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Query Validation Failed by LLM: ${parsed.reason}`,
    });

    return {
      semanticStatus: 'query_error',
      semanticFeedback: `Query Validation Failed by LLM: ${parsed.reason}`,
      semanticErrorTables: parsed.errorTables,
    };
  },
});

function selectSemanticValidationModel<TModel>(
  useSmartModel: boolean,
  smartModel: TModel,
  cheapModel: TModel,
): TModel {
  return useSmartModel ? smartModel : cheapModel;
}

function buildSemanticValidationPrompt(params: {
  userPrompt: string;
  sql: string;
  schema: string;
  tableNames: string[];
  checklist: string | undefined;
  feedbacks: string[] | undefined;
}): string {
  const feedbacksText = params.feedbacks?.length
    ? SEMANTIC_FEEDBACK_PROMPT.replace(
        '{feedback}',
        params.feedbacks.join('\n'),
      )
    : '';

  return SEMANTIC_VALIDATION_PROMPT.replace('{userPrompt}', params.userPrompt)
    .replace('{query}', params.sql)
    .replace('{schema}', params.schema)
    .replace('{tableNames}', params.tableNames.join(', '))
    .replace('{checklist}', params.checklist ?? 'No checklist provided.')
    .replace('{feedbacks}', feedbacksText);
}

function parseSemanticValidationResponse(response: string): {
  isValid: boolean;
  reason: string;
  errorTables: string[];
} {
  const invalidMatch = /<invalid>(.*?)<\/invalid>/s.exec(response);
  const tablesMatch = /<tables>(.*?)<\/tables>/s.exec(response);
  const isValid =
    response.includes('<valid/>') || response.includes('<valid />');

  if (isValid && !invalidMatch) {
    return {isValid: true, reason: '', errorTables: []};
  }

  return {
    isValid: false,
    reason: invalidMatch ? invalidMatch[1].trim() : response.trim(),
    errorTables: tablesMatch
      ? tablesMatch[1]
          .split(',')
          .map(tableName => tableName.trim())
          .filter(tableName => tableName.length > 0)
      : [],
  };
}

function filterByPermissions(
  tables: string[],
  permissionHelper:
    | {findMissingPermissions(tables: string[]): string[]}
    | undefined,
): string[] {
  if (!permissionHelper) return tables;
  return tables.filter(t => {
    const name = t.toLowerCase().slice(t.indexOf('.') + 1);
    return permissionHelper.findMissingPermissions([name]).length === 0;
  });
}

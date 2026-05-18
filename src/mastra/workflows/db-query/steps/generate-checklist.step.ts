import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const CHECKLIST_PROMPT = `
<instructions>
You are given a user question, the tables selected for SQL generation, the relevant database schema, and a numbered list of rules/checks.
Return ONLY the indexes of the rules that are relevant to the user's question, the selected tables, and the given schema.

A rule is relevant if:
- It directly affects how a correct SQL query should be written for this question.
- It is a dependency of another relevant rule (e.g. if rule 3 requires a currency conversion, and rule 5 defines how currency conversion works, both must be included).
- It applies to any of the selected tables or their relationships.

After selecting relevant rules, review your selection and ensure:
- Any rule that is referenced by, or is a prerequisite for, another selected rule is also included.
- Do not include rules that are completely unrelated to the question, schema, or selected tables.
</instructions>

<user-question>
{prompt}
</user-question>

<selected-tables>
{tables}
</selected-tables>

<database-schema>
{schema}
</database-schema>

<rules>
{indexedChecks}
</rules>

<output-instructions>
Return only a comma-separated list of the relevant rule indexes.
Do not include any other text, explanation, or formatting.
Example: 1,3,5
If no rules are relevant, return: none
</output-instructions>`;

/**
 * GenerateChecklistStep — replaces GenerateChecklistNode.
 *
 * Filters the global validation rules/checks to only those relevant
 * to the current query and schema. Used by semantic validation.
 */
export const generateChecklistStep = createStep({
  id: 'generate-checklist',
  inputSchema: z.object({
    prompt: z.string(),
    schema: DatabaseSchemaZ,
    validationChecklist: z.string().optional(),
  }),
  outputSchema: z.object({
    validationChecklist: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaHelper = ctx.get('schemaHelper');
    const globalContext = ctx.get('globalContext');
    const schema = inputData.schema as DatabaseSchema;

    const allChecks = collectChecklistRules(
      globalContext,
      schemaHelper.getTablesContext(schema),
    );
    if (
      shouldSkipChecklistGeneration({
        checklistGenerationEnabled:
          dbQueryConfig.nodes?.generateChecklistNode?.enabled !== false,
        existingChecklist: inputData.validationChecklist,
        tableCount: Object.keys(schema.tables).length,
        availableRuleCount: allChecks.length,
      })
    ) {
      return {};
    }

    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Filtering validation checklist for semantic validation.',
    });

    const indexedChecks = toIndexedChecklist(allChecks);

    const parallelism =
      dbQueryConfig.nodes?.generateChecklistNode?.parallelism ?? 1;

    const invokePrompt = buildChecklistPrompt(
      inputData.prompt,
      Object.keys(schema.tables).join(', '),
      schemaHelper.asString(schema),
      indexedChecks,
    );

    const results = await Promise.all(
      Array.from({length: parallelism}, () =>
        invokeLlm(cheapLlm, invokePrompt),
      ),
    );

    const mergedIndexes = new Set<number>();
    for (const output of results) {
      parseIndexes(stripThinkingTokens(output), allChecks.length).forEach(n =>
        mergedIndexes.add(n),
      );
    }

    if (mergedIndexes.size === 0) {
      return {};
    }

    const validationChecklist = Array.from(mergedIndexes)
      .sort((a, b) => a - b)
      .map(i => allChecks[i - 1])
      .join('\n');

    return {validationChecklist};
  },
});

function parseIndexes(response: string, maxIndex: number): number[] {
  const trimmed = response.trim();
  if (!trimmed || trimmed === 'none') return [];
  return trimmed
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n) && n >= 1 && n <= maxIndex);
}

function collectChecklistRules(
  globalContext: string[] | undefined,
  tableContext: string[],
): string[] {
  return [...(globalContext ?? []), ...tableContext];
}

function shouldSkipChecklistGeneration(params: {
  checklistGenerationEnabled: boolean;
  existingChecklist: string | undefined;
  tableCount: number;
  availableRuleCount: number;
}): boolean {
  return (
    !params.checklistGenerationEnabled ||
    !!params.existingChecklist ||
    params.tableCount <= 2 ||
    params.availableRuleCount === 0
  );
}

function toIndexedChecklist(checks: string[]): string {
  return checks.map((check, i) => `${i + 1}. ${check}`).join('\n');
}

function buildChecklistPrompt(
  prompt: string,
  tables: string,
  schema: string,
  indexedChecks: string,
): string {
  return CHECKLIST_PROMPT.replace('{prompt}', prompt)
    .replace('{tables}', tables)
    .replace('{schema}', schema)
    .replace('{indexedChecks}', indexedChecks);
}

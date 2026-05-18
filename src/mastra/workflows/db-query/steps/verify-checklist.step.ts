import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';
import type {DatabaseSchema} from '../../../../components/db-query/types';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';

const VERIFY_BASE_PROMPT = `
<instructions>
You are given a user question, the tables selected for SQL generation, the relevant database schema, and a numbered list of rules/checks.
Return ONLY the indexes of the rules that are relevant to the user's question, the selected tables, and the given schema.

A rule is relevant if:
- It directly affects how a correct SQL query should be written for this question.
- It is a dependency of another relevant rule (e.g. if rule 3 requires a currency conversion, and rule 5 defines how currency conversion works, both must be included).
- It applies to any of the selected tables or their relationships.

Ensure:
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

`;

const EVALUATION_OUTPUT = `<output-instructions>
First, evaluate each rule inside an evaluation tag. For each rule, repeat the full rule text exactly as given, followed by " — Include" or " — Exclude" with a brief reason.
Then, return only the comma-separated list of included rule indexes inside a result tag.

Example:
<evaluation>
1. When matching names, use ilike with wildcards — Include, query involves name matching
2. Format dates using to_char — Exclude, no date fields in this query
3. Always exclude lost deals — Include, query involves deals
</evaluation>
<result>1,3</result>

If no rules are relevant: <result>none</result>
</output-instructions>`;

const SIMPLE_OUTPUT = `<output-instructions>
Return ONLY the comma-separated list of relevant rule indexes inside a result tag.
Do NOT include any reasoning, analysis, or explanation — only the result tag.
Example: 
<result>1,3,5</result>
If no rules are relevant:
<result>none</result>
</output-instructions>`;

/**
 * VerifyChecklistStep — replaces VerifyChecklistNode.
 *
 * Uses a smart LLM to verify/refine the checklist with chain-of-thought.
 * Runs only on first attempt (no feedbacks yet) with 3+ tables.
 */
export const verifyChecklistStep = createStep({
  id: 'verify-checklist',
  inputSchema: z.object({
    prompt: z.string(),
    schema: DatabaseSchemaZ,
    validationChecklist: z.string().optional(),
    feedbacks: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    validationChecklist: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asDbQueryContext(requestContext!);
    const smartLlm = ctx.get('smartLlm');
    const smartNonThinkingLlm = ctx.get('smartNonThinkingLlm');
    const dbQueryConfig = ctx.get('dbQueryConfig');
    const schemaHelper = ctx.get('schemaHelper');
    const globalContext = ctx.get('globalContext');
    const schema = inputData.schema as DatabaseSchema;

    const allChecks = collectChecklistRules(
      globalContext,
      schemaHelper.getTablesContext(schema),
    );
    if (
      shouldSkipChecklistVerification({
        checklistVerificationEnabled:
          dbQueryConfig.nodes?.verifyChecklistNode?.enabled !== false,
        hasFeedbacks: !!inputData.feedbacks?.length,
        tableCount: Object.keys(schema.tables).length,
        availableRuleCount: allChecks.length,
      })
    ) {
      return {};
    }

    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Verifying validation checklist with chain-of-thought.',
    });

    const llm = smartNonThinkingLlm ?? smartLlm;
    const indexedChecks = toIndexedChecklist(allChecks);

    const useEvaluation =
      dbQueryConfig.nodes?.verifyChecklistNode?.evaluation ?? false;
    const outputInstructions = useEvaluation
      ? EVALUATION_OUTPUT
      : SIMPLE_OUTPUT;

    const prompt = buildVerificationPrompt(
      inputData.prompt,
      Object.keys(schema.tables).join(', '),
      schemaHelper.asString(schema),
      indexedChecks,
      outputInstructions,
    );

    const rawOutput = await invokeLlm(llm, prompt);
    const verifiedIndexes = parseVerifiedIndexes(
      stripThinkingTokens(rawOutput),
      allChecks.length,
    );

    if (verifiedIndexes.length === 0) {
      return {};
    }

    const validationChecklist = mergeWithExisting(
      inputData.validationChecklist,
      verifiedIndexes,
      allChecks,
    );

    return {validationChecklist};
  },
});

function parseVerifiedIndexes(response: string, maxIndex: number): number[] {
  const resultMatch = /<result>(.*?)<\/result>/s.exec(response);
  const indexStr = resultMatch ? resultMatch[1].trim() : response.trim();

  if (!indexStr || indexStr === 'none') return [];

  return indexStr
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n) && n >= 1 && n <= maxIndex);
}

function mergeWithExisting(
  existing: string | undefined,
  verifiedIndexes: number[],
  allChecks: string[],
): string {
  const existingChecks = new Set(
    (existing ?? '').split('\n').filter(c => c.length > 0),
  );
  for (const check of verifiedIndexes.map(i => allChecks[i - 1])) {
    existingChecks.add(check);
  }
  return Array.from(existingChecks).join('\n');
}

function collectChecklistRules(
  globalContext: string[] | undefined,
  tableContext: string[],
): string[] {
  return [...(globalContext ?? []), ...tableContext];
}

function shouldSkipChecklistVerification(params: {
  checklistVerificationEnabled: boolean;
  hasFeedbacks: boolean;
  tableCount: number;
  availableRuleCount: number;
}): boolean {
  return (
    !params.checklistVerificationEnabled ||
    params.hasFeedbacks ||
    params.tableCount <= 2 ||
    params.availableRuleCount === 0
  );
}

function toIndexedChecklist(checks: string[]): string {
  return checks.map((check, i) => `${i + 1}. ${check}`).join('\n');
}

function buildVerificationPrompt(
  prompt: string,
  tables: string,
  schema: string,
  indexedChecks: string,
  outputInstructions: string,
): string {
  return (VERIFY_BASE_PROMPT + outputInstructions)
    .replace('{prompt}', prompt)
    .replace('{tables}', tables)
    .replace('{schema}', schema)
    .replace('{indexedChecks}', indexedChecks);
}

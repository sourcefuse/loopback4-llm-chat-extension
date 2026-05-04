import {generateText} from 'ai';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {DbQueryConfig} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../types/db-query.types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';

const debug = require('debug')(
  'ai-integration:mastra:db-query:verify-checklist',
);

const BASE_PROMPT = `
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

export type VerifyChecklistStepDeps = {
  smartLlm: LLMProvider;
  smartNonThinkingLlm?: LLMProvider;
  config: DbQueryConfig;
  schemaHelper: DbSchemaHelperService;
  checks?: string[];
};

/**
 * A second-pass checklist filter that runs only for schemas with more than two
 * tables. Supports an optional chain-of-thought "evaluation" mode. Merges
 * verified indexes with any checklist already in state.
 */
export async function verifyChecklistStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: VerifyChecklistStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {tables: Object.keys(state.schema?.tables ?? {})});

  if (deps.config.nodes?.verifyChecklistNode?.enabled === false) {
    return {};
  }

  if (state.feedbacks?.length) {
    return {};
  }

  const tableCount = Object.keys(state.schema?.tables ?? {}).length;
  if (tableCount <= 2) {
    return {};
  }

  const allChecks = [
    ...(deps.checks ?? []),
    ...deps.schemaHelper.getTablesContext(state.schema),
  ];

  if (allChecks.length === 0) {
    return {};
  }

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: 'Verifying validation checklist with chain-of-thought.',
  });

  const llm = deps.smartNonThinkingLlm ?? deps.smartLlm;
  const indexedChecks = allChecks
    .map((check, i) => `${i + 1}. ${check}`)
    .join('\n');
  const useEvaluation =
    deps.config.nodes?.verifyChecklistNode?.evaluation ?? false;

  const content = buildPrompt(
    BASE_PROMPT + (useEvaluation ? EVALUATION_OUTPUT : SIMPLE_OUTPUT),
    {
      prompt: state.prompt,
      tables: Object.keys(state.schema?.tables ?? {}).join(', '),
      schema: deps.schemaHelper.asString(state.schema),
      indexedChecks,
    },
  );

  debug(
    'invoking LLM for checklist verification (evaluation=%s)',
    useEvaluation,
  );
  const {text, usage} = await generateText({
    model: llm,
    messages: [{role: 'user', content}],
  });
  context.onUsage?.(usage.inputTokens ?? 0, usage.outputTokens ?? 0, 'unknown');
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });

  const response = stripThinkingFromText(text).trim();
  const verifiedIndexes = parseVerifiedIndexes(response, allChecks.length);

  if (verifiedIndexes.length === 0) {
    return {};
  }

  const validationChecklist = mergeWithExisting(
    state.validationChecklist,
    verifiedIndexes,
    allChecks,
  );

  debug('step result checklist rules=%d', verifiedIndexes.length);
  return {validationChecklist};
}

function parseVerifiedIndexes(response: string, maxIndex: number): number[] {
  const resultMatch = /<result>(.*?)<\/result>/s.exec(response);
  const indexStr = resultMatch ? resultMatch[1].trim() : response;

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

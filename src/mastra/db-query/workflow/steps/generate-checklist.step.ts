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
  'ai-integration:mastra:db-query:generate-checklist',
);

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

export type GenerateChecklistStepDeps = {
  llm: LLMProvider;
  config: DbQueryConfig;
  schemaHelper: DbSchemaHelperService;
  checks?: string[];
};

/**
 * Filters the global validation checklist down to rules that are relevant to
 * the current query context. Runs the LLM `parallelism` times concurrently
 * with `Promise.all()` and merges the result sets by union.
 */
export async function generateChecklistStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: GenerateChecklistStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {tables: Object.keys(state.schema?.tables ?? {})});

  if (deps.config.nodes?.generateChecklistNode?.enabled === false) {
    debug('generateChecklistNode disabled by config');
    return {};
  }

  if (state.validationChecklist) {
    debug('validationChecklist already set — skipping');
    return {};
  }

  const tableCount = Object.keys(state.schema?.tables ?? {}).length;
  if (tableCount <= 2) {
    debug('too few tables (%d) — skipping checklist generation', tableCount);
    return {};
  }

  const allChecks = [
    ...(deps.checks ?? []),
    ...deps.schemaHelper.getTablesContext(state.schema),
  ];

  if (allChecks.length === 0) {
    debug('no checks available — skipping');
    return {};
  }

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: 'Filtering validation checklist for semantic validation.',
  });

  const mergedIndexes = await runParallelChecklist(
    state,
    allChecks,
    deps,
    context,
  );

  if (mergedIndexes.size === 0) {
    return {};
  }

  const validationChecklist = Array.from(mergedIndexes)
    .sort((a, b) => a - b)
    .map(i => allChecks[i - 1])
    .join('\n');

  debug('generated checklist with %d rules', mergedIndexes.size);
  return {validationChecklist};
}

async function runParallelChecklist(
  state: DbQueryState,
  allChecks: string[],
  deps: GenerateChecklistStepDeps,
  context: MastraDbQueryContext,
): Promise<Set<number>> {
  const indexedChecks = allChecks
    .map((check, i) => `${i + 1}. ${check}`)
    .join('\n');
  const parallelism =
    deps.config.nodes?.generateChecklistNode?.parallelism ?? 1;

  const content = buildPrompt(CHECKLIST_PROMPT, {
    prompt: state.prompt,
    tables: Object.keys(state.schema?.tables ?? {}).join(', '),
    schema: deps.schemaHelper.asString(state.schema),
    indexedChecks,
  });

  const results = await Promise.all(
    Array.from({length: parallelism}, () =>
      generateText({model: deps.llm, messages: [{role: 'user', content}]}),
    ),
  );

  const mergedIndexes = new Set<number>();
  for (const {text, usage} of results) {
    context.onUsage?.(
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      'unknown',
    );
    debug('token usage captured', {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
    });
    parseIndexes(stripThinkingFromText(text), allChecks.length).forEach(n =>
      mergedIndexes.add(n),
    );
  }
  return mergedIndexes;
}

function parseIndexes(response: string, maxIndex: number): number[] {
  const trimmed = response.trim();
  if (!trimmed || trimmed === 'none') return [];
  return trimmed
    .split(',')
    .map(s => Number.parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n) && n >= 1 && n <= maxIndex);
}

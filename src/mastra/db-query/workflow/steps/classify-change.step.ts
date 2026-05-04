import {generateText} from 'ai';
import {DbQueryState} from '../../../../components/db-query/state';
import {ChangeType} from '../../../../components/db-query/types';
import {LLMStreamEventType} from '../../../../types/events';
import {LLMProvider} from '../../../../types';
import {buildPrompt} from '../../utils/prompt.util';
import {stripThinkingFromText} from '../../utils/thinking.util';
import {MastraDbQueryContext} from '../../types/db-query.types';

const debug = require('debug')(
  'ai-integration:mastra:db-query:classify-change',
);

const CLASSIFY_PROMPT = `
<instructions>
You are given the original description of a SQL query and a new description that includes user feedback.
Your task is to classify the level of change required to transform the original query into the new one.

Classify as one of:
- **minor**: Small tweaks such as changing a filter value, adjusting a limit, adding/removing a single condition, or renaming an alias.
- **major**: Structural changes like adding/removing joins, changing grouping logic, adding subqueries, or significantly altering the WHERE clause.
- **rewrite**: The intent of the query has fundamentally changed, requiring a completely new query from scratch.
</instructions>

<original-description>
{originalDescription}
</original-description>

<new-description>
{newDescription}
</new-description>

<output-instructions>
Return ONLY one of: minor, major, rewrite
Do not include any other text, explanation, or formatting.
</output-instructions>`;

export type ClassifyChangeStepDeps = {
  llm: LLMProvider;
};

/**
 * Classifies the magnitude of change between a cached SQL query and the
 * user's new request. The classification guides downstream step selection
 * (e.g. cheap vs. smart LLM in `sqlGenerationStep`).
 */
export async function classifyChangeStep(
  state: DbQueryState,
  context: MastraDbQueryContext,
  deps: ClassifyChangeStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {hasSampleSql: !!state.sampleSql});

  if (!state.sampleSql) {
    debug('no sampleSql — skipping change classification');
    return {};
  }

  context.writer?.({
    type: LLMStreamEventType.Log,
    data: 'Classifying the level of change required for the query.',
  });

  const content = buildPrompt(CLASSIFY_PROMPT, {
    originalDescription: state.sampleSqlPrompt ?? '',
    newDescription: state.prompt,
  });

  debug('classifying change');
  const {text, usage} = await generateText({
    model: deps.llm,
    messages: [{role: 'user', content}],
  });
  context.onUsage?.(usage.inputTokens ?? 0, usage.outputTokens ?? 0, 'unknown');
  debug('token usage captured', {
    promptTokens: usage.inputTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  });

  const response = stripThinkingFromText(text).trim().toLowerCase();
  const changeType = parseChangeType(response);

  debug('change classified as: %s', changeType);
  context.writer?.({
    type: LLMStreamEventType.Log,
    data: `Change classified as: ${changeType}`,
  });

  const result = {changeType};
  debug('step result', result);
  return result;
}

function parseChangeType(response: string): ChangeType {
  if (response.includes(ChangeType.Minor)) return ChangeType.Minor;
  if (response.includes(ChangeType.Rewrite)) return ChangeType.Rewrite;
  return ChangeType.Major;
}

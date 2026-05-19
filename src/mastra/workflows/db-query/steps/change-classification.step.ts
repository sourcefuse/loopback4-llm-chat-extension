import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asDbQueryContext} from '../db-query-request-context';
import {invokeLlm, stripThinkingTokens} from '../llm-helpers';

const CLASSIFY_CHANGE_PROMPT = `
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

/**
 * ChangeClassificationStep — replaces ClassifyChangeNode.
 *
 * When improving an existing query (sampleSql exists), classifies
 * the level of change needed: minor, major, or rewrite.
 * This determines which LLM to use for SQL generation.
 */
export const changeClassificationStep = createStep({
  id: 'change-classification',
  inputSchema: z.object({
    prompt: z.string(),
    sampleSql: z.string().optional(),
    sampleSqlPrompt: z.string().optional(),
  }),
  outputSchema: z.object({
    changeType: z.enum(['minor', 'major', 'rewrite']).optional(),
  }),
  execute: async ({inputData, requestContext, writer}) => {
    if (!inputData.sampleSql) {
      return {};
    }

    const ctx = asDbQueryContext(requestContext!);
    const cheapLlm = ctx.get('cheapLlm');

    await writer.write({
      type: LLMStreamEventType.Log,
      data: 'Classifying the level of change required for the query.',
    });

    const prompt = CLASSIFY_CHANGE_PROMPT.replace(
      '{originalDescription}',
      inputData.sampleSqlPrompt ?? '',
    ).replace('{newDescription}', inputData.prompt);

    const rawOutput = await invokeLlm(cheapLlm, prompt);
    const response = stripThinkingTokens(rawOutput).trim().toLowerCase();

    const changeType = parseChangeType(response);

    await writer.write({
      type: LLMStreamEventType.Log,
      data: `Change classified as: ${changeType}`,
    });

    return {changeType};
  },
});

function parseChangeType(response: string): 'minor' | 'major' | 'rewrite' {
  if (response.includes('minor')) return 'minor';
  if (response.includes('rewrite')) return 'rewrite';
  return 'major';
}

import {Agent} from '@mastra/core/agent';
import type {MastraLanguageModel} from '@mastra/core/agent';

/**
 * Invoke an LLM with a prompt string and return the text response.
 * Uses Mastra Agent.generate() as the project does not depend on the `ai` package directly.
 *
 * @param llm - Mastra language model
 * @param prompt - Formatted prompt string
 * @returns Raw text response from the LLM
 */
export async function invokeLlm(
  llm: MastraLanguageModel,
  prompt: string,
): Promise<string> {
  const agent = new Agent({
    id: 'db-query-llm-agent',
    name: 'DB Query LLM',
    instructions: 'You are a helpful assistant.',
    model: llm,
  });
  const result = await agent.generate([{role: 'user', content: prompt}]);
  return result.text ?? '';
}

/**
 * Strip `<think>...</think>` or `<thinking>...</thinking>` tags from LLM output.
 * Handles incomplete opening tags at the start of the response.
 */
export function stripThinkingTokens(text: string): string {
  let cleaned = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/g, '');
  // Handle case where response starts mid-thinking block (no opening tag)
  cleaned = cleaned.replace(/^[\s\S]*?<\/think(ing)?>/g, '');
  return cleaned.trim();
}

/**
 * Strip markdown code block fences from SQL output.
 */
export function stripCodeBlock(text: string): string {
  return text
    .replace(/^```(?:sql)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

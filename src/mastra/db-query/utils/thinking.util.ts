/**
 * Strips `<think>` / `<thinking>` reasoning blocks from an AI response string.
 *
 * This is the string-based counterpart of `stripThinkingTokens()` in
 * `src/utils.ts` (which operates on a LangChain `AIMessage`). Use this
 * function in all Mastra-path nodes where the AI SDK returns a plain `string`.
 *
 * Handles three cases:
 *  1. Complete blocks — `<think>...</think>` or `<thinking>...</thinking>`
 *  2. Dangling close tags — `...some preamble</think>` (reasoning model
 *     token budget exhausted mid-block)
 *  3. Whitespace trimming after stripping
 *
 * @param text - Raw text string from `generateText().text` or accumulated
 *               `streamText` chunks.
 * @returns The cleaned response string with all thinking tokens removed.
 */
export function stripThinkingFromText(text: string): string {
  // Remove complete <think>...</think> and <thinking>...</thinking> blocks
  let result = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, '');
  // Remove dangling close tags and everything before them
  result = result.replace(/^[\s\S]*?<\/think(ing)?>/gi, '');
  return result.trim();
}

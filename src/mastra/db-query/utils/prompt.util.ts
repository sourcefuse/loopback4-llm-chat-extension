/**
 * Formats a LangChain-style prompt template using simple variable substitution.
 *
 * Handles the standard `PromptTemplate.fromTemplate` syntax:
 *  - `{variableName}` → replaced with the corresponding value
 *  - `{{` / `}}` → literal braces (used in JSON examples in templates)
 *
 * @param template - The template string with `{var}` placeholders.
 * @param vars - A map of variable names to their string values.
 * @returns The formatted prompt string ready to send to the LLM.
 */
export function buildPrompt(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template
    .replace(/\{\{/g, '__LBRACE__')
    .replace(/\}\}/g, '__RBRACE__')
    .replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '')
    .replace(/__LBRACE__/g, '{')
    .replace(/__RBRACE__/g, '}');
}

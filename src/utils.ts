export function getTextContent(content: string | unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === 'string') return c;
        if (
          c !== null &&
          typeof c === 'object' &&
          'text' in c &&
          typeof (c as {text: unknown}).text === 'string'
        ) {
          return (c as {text: string}).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

export function mergeAttachments(
  prompt: string,
  fileName: string,
  summary: string,
): string {
  return `${prompt}
summary of file - ${fileName}:
${summary}`;
}

/**
 * Strips `<think>` / `<thinking>` tags from a plain text string.
 * Previously accepted `AIMessage` — now accepts a plain string so this
 * function has zero dependency on @langchain.
 */
export function stripThinkingTokens(text: string): string {
  // remove all the content between <think> and <thinking> tags
  let stripped = text.replace(/<think(ing)?>.*?<\/think(ing)?>/gs, '');
  // also strip any string that ends with </thinking> or </think>
  stripped = stripped.replace(/.*?<\/think(ing)?>/gs, '');
  return stripped.trim();
}

export function approxTokenCounter(content: string | unknown): number {
  const text = getTextContent(content);
  // Approximate token count: 1 token ~ 4 characters
  // This is a rough estimate, actual tokenization may vary
  return Math.ceil(text.length / 4);
}

export function numericEnumValues(enumType: Object) {
  return Object.keys(enumType)
    .map(key => Number(key))
    .filter(value => !isNaN(value));
}

export function buildEnumValuesString(numericEnum: Object): string {
  return numericEnumValues(numericEnum)
    .map(
      type =>
        `(${type}: ${numericEnum[type as unknown as keyof typeof numericEnum]})`,
    )
    .join(', ');
}

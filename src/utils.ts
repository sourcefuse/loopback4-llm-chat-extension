type TextContentPart = {
  type?: string;
  text?: string;
};

type TextLikeContent = string | TextContentPart | TextContentPart[];

export function isTextContent(content: unknown): content is TextLikeContent {
  if (typeof content === 'string') {
    return true;
  }
  if (
    typeof content === 'object' &&
    content !== null &&
    typeof (content as TextContentPart).text === 'string'
  ) {
    return true;
  }
  if (Array.isArray(content)) {
    return content
      .filter(v => typeof v === 'object' && v !== null)
      .filter(v => (v as TextContentPart).type === 'text')
      .every(isTextContent);
  }
  return false;
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

export function getTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!isTextContent(content)) {
    return '';
  }
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  if (typeof content === 'object' && content !== null) {
    return (content as TextContentPart).text ?? '';
  }
  return '';
}

export function stripThinkingTokens(text: unknown): string {
  const message =
    typeof text === 'object' && text !== null && 'content' in text
      ? getTextContent((text as {content?: unknown}).content)
      : getTextContent(text);
  // remove all the content between <think> and <thinking> tags
  let stripped = message.replace(/<think(ing)?>.*?<\/think(ing)?>/gs, '');
  // also strip any string that ends with <thinking> or <think>
  stripped = stripped.replace(/.*?<\/think(ing)?>/gs, '');
  return stripped.trim();
}

export function approxTokenCounter(content: unknown): number {
  const text = getTextContent(content);
  // Approximate token count: 1 token ~ 4 characters
  // This is a rough estimate, actual tokenization may vary
  if (typeof text === 'string') {
    return Math.ceil(text.length / 4);
  }

  return 0;
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

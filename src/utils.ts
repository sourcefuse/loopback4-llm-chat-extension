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
  const stripped = message.replace(/<think(ing)?>.*?<\/think(ing)?>/gs, '');
  // Also drop any orphaned leading reasoning: everything up to and including
  // the LAST closing think tag (covers streamed output where the opening tag
  // was already consumed). Done with lastIndexOf rather than a `.*?</think>`
  // regex — the unanchored lazy pattern backtracks super-linearly (S8786) on
  // input that has no closing tag, e.g. a long plain answer.
  return stripBeforeLastClosingThinkTag(stripped).trim();
}

function stripBeforeLastClosingThinkTag(text: string): string {
  let cut = -1;
  for (const tag of ['</thinking>', '</think>']) {
    const idx = text.lastIndexOf(tag);
    if (idx !== -1) cut = Math.max(cut, idx + tag.length);
  }
  return cut === -1 ? text : text.slice(cut);
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

/**
 * Strip trailing `/` characters from a base URL without a regex — a `/\/+$/`
 * pattern trips SonarQube's super-linear-backtracking rule (S8786). Linear scan.
 */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
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

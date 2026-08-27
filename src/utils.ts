import type {ModelMessage} from './graphs/messages';

/** Content of an AI SDK model message: a string or an array of content parts. */
type MessageContent = ModelMessage['content'];

export function isTextContent(content: MessageContent): boolean {
  if (typeof content === 'string') {
    return true;
  }
  return content.every(part => part.type === 'text');
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

export function getTextContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map(part => (part.type === 'text' ? part.text : ''))
    .filter(v => !!v)
    .join('');
}

export function stripThinkingTokens(message: ModelMessage | string): string {
  const text =
    typeof message === 'string' ? message : getTextContent(message.content);
  // remove all the content between <think> and <thinking> tags
  let stripped = text.replace(/<think(ing)?>.*?<\/think(ing)?>/gs, '');
  // also strip any string that ends with <thinking> or <think>
  stripped = stripped.replace(/.*?<\/think(ing)?>/gs, '');
  return stripped.trim();
}

export function approxTokenCounter(content: MessageContent): number {
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

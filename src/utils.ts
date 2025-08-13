import {
  AIMessage,
  MessageContent,
  MessageContentComplex,
  MessageContentText,
} from '@langchain/core/messages';

export function isTextContent(
  content: MessageContent | MessageContentComplex | string,
): content is MessageContentText {
  if (typeof content === 'string') {
    return true;
  }
  if ((content as MessageContentText).text !== undefined) {
    return true;
  }
  if (Array.isArray(content)) {
    return content.every(isTextContent);
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

export function getTextContent(content: MessageContent): string {
  if (isTextContent(content)) {
    return typeof content === 'string'
      ? content
      : content.map(c => (isTextContent(c) ? c.text : '')).join('');
  }
  return '';
}

export function stripThinkingTokens(text: AIMessage): string {
  const message = text.content.toString();
  // remove all the content between <think> and <thinking> tags
  let stripped = message.replace(/<think(ing)?>.*?<\/think(ing)?>/gs, '');
  // also strip any string that ends with <thinking> or <think>
  stripped = stripped.replace(/.*?<\/think(ing)?>/gs, '');
  return stripped.trim();
}

export function approxTokenCounter(content: MessageContent): number {
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

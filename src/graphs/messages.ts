/**
 * Message helpers over the AI SDK's native `ModelMessage`.
 *
 * There are no custom message classes: a message is a plain AI SDK
 * `ModelMessage` object (`{role, content}`). These helpers only build and read
 * those native objects — construction (`humanMessage`, `assistantMessage`,
 * `toolResultMessage`), text extraction, and tool-call extraction — plus the
 * `trimMessages` utility the context-compression node needs.
 */
import type {
  AssistantContent,
  ModelMessage,
  ToolCallPart,
  UserContent,
} from 'ai';

export type {ModelMessage} from 'ai';

/** A list of AI SDK model messages (replaces LangGraph's `Messages`). */
export type Messages = ModelMessage[];

/** Extracts the plain-text portion of a message's content. */
export function getMessageText(message: ModelMessage): string {
  return contentToText(message.content);
}

/** Extracts text from any AI SDK message content (string or content parts). */
export function contentToText(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map(part => (part.type === 'text' ? part.text : '')).join('');
}

/** Returns the tool-call parts of an assistant message (empty for others). */
export function getToolCalls(
  message: ModelMessage | undefined,
): ToolCallPart[] {
  if (
    !message ||
    message.role !== 'assistant' ||
    typeof message.content === 'string'
  ) {
    return [];
  }
  return message.content.filter(
    (part): part is ToolCallPart => part.type === 'tool-call',
  );
}

export function systemMessage(content: string): ModelMessage {
  return {role: 'system', content};
}

export function humanMessage(content: UserContent): ModelMessage {
  return {role: 'user', content};
}

export function assistantMessage(content: AssistantContent): ModelMessage {
  return {role: 'assistant', content};
}

/** Builds a `tool`-role message carrying a single tool result. */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  output: string,
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: {type: 'text', value: output},
      },
    ],
  };
}

export interface TrimMessagesOptions {
  maxTokens: number;
  strategy?: 'first' | 'last';
  tokenCounter: (messages: ModelMessage[]) => number;
  includeSystem?: boolean;
}

/**
 * Keeps the most recent messages within a token budget (`strategy: 'last'`),
 * always retaining leading system messages when `includeSystem` is set.
 * Provider-agnostic — the token counter is supplied by the caller.
 */
export async function trimMessages(
  messages: ModelMessage[],
  options: TrimMessagesOptions,
): Promise<ModelMessage[]> {
  const {maxTokens, tokenCounter, includeSystem = false} = options;
  const strategy = options.strategy ?? 'last';

  const systemMessages = includeSystem
    ? messages.filter(m => m.role === 'system')
    : [];
  const rest = includeSystem
    ? messages.filter(m => m.role !== 'system')
    : messages.slice();

  const budget = maxTokens - tokenCounter(systemMessages);
  const kept: ModelMessage[] = [];

  const ordered = strategy === 'last' ? rest.slice().reverse() : rest;
  for (const message of ordered) {
    const candidate =
      strategy === 'last' ? [message, ...kept] : [...kept, message];
    if (tokenCounter(candidate) > budget && kept.length > 0) {
      break;
    }
    if (strategy === 'last') {
      kept.unshift(message);
    } else {
      kept.push(message);
    }
  }

  return [...systemMessages, ...kept];
}

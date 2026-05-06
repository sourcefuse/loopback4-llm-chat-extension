import {LLMStreamEventType} from '../types/events';

/**
 * Maps Mastra workflow events to the existing SSE contract used by transports.
 *
 * Handles both internal step-emitted events (tool-status, message) and
 * AI SDK stream events forwarded from Agent.stream() (tool-call, tool-result,
 * text-delta, finish). Unknown shapes are passed through unchanged to preserve
 * backward compatibility.
 */
export function adaptMastraEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object') {
    return event;
  }

  const typed = event as {
    type?: unknown;
    data?: unknown;
    text?: unknown;
    usage?: unknown;
  };

  switch (typed.type) {
    // Internal step events (already in SSE contract shape)
    case 'tool-status':
      return {type: LLMStreamEventType.ToolStatus, data: typed.data};

    case 'message':
      return {type: LLMStreamEventType.Message, data: typed.data};

    // AI SDK stream events forwarded from Agent.stream()
    case 'tool-call':
      return {type: LLMStreamEventType.Tool, data: typed.data};

    case 'tool-result':
      return {type: LLMStreamEventType.ToolStatus, data: typed.data};

    case 'text-delta':
      return {type: LLMStreamEventType.Message, data: typed.text};

    case 'finish':
      return {type: LLMStreamEventType.TokenCount, data: typed.usage};

    default:
      return event;
  }
}

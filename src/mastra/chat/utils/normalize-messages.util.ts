import {MastraAgentMessage} from '../../types';

/**
 * Converts Mastra-format messages into AI SDK v6 ModelMessage format.
 *
 * Key differences handled:
 * - `tool-call` parts: `args` (Mastra) → `input` (AI SDK v6)
 * - `tool-result` parts: `result` (Mastra) → `output: {type, value}` (AI SDK v6)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeMessages(messages: MastraAgentMessage[]): any[] {
  return messages.map(msg => {
    const {role, content} = msg;

    // System / user messages: content must be a string
    if (role === 'system' || role === 'user') {
      return {
        role,
        content: typeof content === 'string' ? content : String(content ?? ''),
      };
    }

    // Assistant messages: convert tool-call parts (args → input)
    if (role === 'assistant') {
      if (typeof content === 'string') {
        return {role, content};
      }
      if (Array.isArray(content)) {
        const parts = content.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (part: Record<string, any>) => {
            if (part.type === 'tool-call') {
              return {
                type: 'tool-call',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                // AI SDK v6 uses `input`; Mastra stores `args`
                input: part.input ?? part.args ?? {},
              };
            }
            if (part.type === 'text') {
              return {type: 'text', text: part.text ?? ''};
            }
            return part;
          },
        );
        return {role, content: parts};
      }
      return {
        role,
        content: typeof content === 'string' ? content : String(content ?? ''),
      };
    }

    // Tool messages: convert tool-result parts (result → output)
    if (role === 'tool') {
      if (Array.isArray(content)) {
        const parts = content.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (part: Record<string, any>) => {
            if (part.type === 'tool-result') {
              // AI SDK v6 uses `output`; Mastra stores `result`
              const rawResult = part.output ?? part.result;
              const output =
                typeof rawResult === 'string'
                  ? {type: 'text', value: rawResult}
                  : {type: 'json', value: rawResult};
              return {
                type: 'tool-result',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output,
              };
            }
            return part;
          },
        );
        return {role, content: parts};
      }
      return {role, content};
    }

    return msg;
  });
}

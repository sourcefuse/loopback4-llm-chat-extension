import {AnyObject} from '@loopback/repository';

/**
 * A single message in the format accepted by Mastra (compatible with AI SDK `CoreMessage`).
 *
 * The host application's `MastraRuntimeFactory` must return an adapter whose
 * `getAgent('chat-agent')` call yields an object implementing `IMastraChatAgentRunnable`.
 * That object's `stream()` input is typed against these message shapes.
 */
export type MastraAgentMessage =
  | {role: 'system'; content: string}
  | {role: 'user'; content: string}
  | {role: 'assistant'; content: string | MastraAssistantContentPart[]}
  | {role: 'tool'; content: MastraToolResultPart[]};

export type MastraAssistantContentPart =
  | {type: 'text'; text: string}
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    };

export type MastraToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: unknown;
};

/**
 * Options accepted as the second argument of `IMastraChatAgentRunnable.stream()`.
 */
export interface MastraAgentInput {
  signal?: AbortSignal;
  /**
   * Optional thread / chat identifier forwarded to `agent.stream({ threadId })`.
   * Used by the host-app tool `execute()` callbacks to look up the correct
   * per-request `IRuntimeTool` instances from `mastraRequestToolStore`.
   */
  threadId?: string;
  [key: string]: unknown;
}

/**
 * Typed union of all events emitted by the Mastra agent's `fullStream`.
 *
 * Mastra wraps all event data under a `payload` property.
 * The `from`, `runId` fields are always present but not used by our handler.
 */
export type MastraStreamEvent =
  | {
      type: 'text-delta';
      payload: {text: string; id: string; [key: string]: unknown};
      [key: string]: unknown;
    }
  | {
      type: 'tool-call';
      payload: {
        toolCallId: string;
        toolName: string;
        args?: Record<string, unknown>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
  | {
      type: 'tool-result';
      payload: {
        toolCallId: string;
        toolName: string;
        result: unknown;
        args?: Record<string, unknown>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
  | {
      type: 'step-finish';
      payload: {
        output: {
          usage: {
            inputTokens?: number;
            outputTokens?: number;
            [key: string]: unknown;
          };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
  | {
      type: 'finish';
      payload: {
        output: {
          usage: {
            inputTokens?: number;
            outputTokens?: number;
            [key: string]: unknown;
          };
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }
  | {type: string; payload?: unknown; [key: string]: unknown};

/**
 * The async stream object returned by `IMastraChatAgentRunnable.stream()`.
 */
export interface MastraAgentStreamOutput {
  /**
   * Emits every stream event — text deltas, tool calls, tool results, step
   * boundaries, and the final finish event.
   */
  fullStream: AsyncIterable<MastraStreamEvent>;
  /**
   * Resolves to the aggregate token usage once the full stream is consumed.
   * Mastra returns `LanguageModelUsage` with `inputTokens`/`outputTokens`.
   * May resolve to `undefined` if the agent does not report usage.
   */
  usage: Promise<{inputTokens?: number; outputTokens?: number} | undefined>;
}

/**
 * Minimal contract for a Mastra agent capable of multi-step chat with tool calling.
 *
 * The library depends only on this interface — it does NOT import `@mastra/core`
 * directly.  The host application's `MastraRuntimeFactory` is responsible for
 * creating and returning an object that satisfies this contract.
 *
 * A real `@mastra/core` `Agent` instance is directly assignable to this interface.
 */
export interface IMastraChatAgentRunnable {
  /**
   * Matches the real `@mastra/core` `Agent.stream(messages, options)` signature.
   * Messages are passed as the first argument; options (threadId, signal, etc.) as second.
   */
  stream(
    messages: MastraAgentMessage[],
    options?: MastraAgentInput,
  ): Promise<MastraAgentStreamOutput>;
}

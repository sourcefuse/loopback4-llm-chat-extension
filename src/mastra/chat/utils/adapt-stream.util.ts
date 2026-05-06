import {streamText} from 'ai';
import {MastraAgentStreamOutput, MastraStreamEvent} from '../../types';

type StreamLike = {
  fullStream: AsyncIterable<unknown>;
  usage: PromiseLike<unknown> | Promise<unknown>;
};

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
};

type StreamPartLike = {
  type?: string;
  id?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  usage?: UsageLike;
  totalUsage?: UsageLike;
  // Mastra native stream events wrap all data under `payload`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: Record<string, any>;
};

/**
 * Adapts the AI SDK v6 `StreamTextResult.fullStream` into the
 * `MastraAgentStreamOutput` shape consumed by `handleStream()`.
 *
 * This allows `MastraChatAgent` to call `streamText()` directly while
 * reusing the existing `handleStream` event-processing logic unchanged.
 *
 * ### AI SDK v6 → Mastra event mapping
 * | AI SDK v6 event type | Mapped to Mastra `type`  | Notes                                |
 * |----------------------|--------------------------|--------------------------------------|
 * | `text-delta`         | `text-delta`             | `part.text` → `payload.text`         |
 * | `tool-call`          | `tool-call`              | `part.input` → `payload.args`        |
 * | `tool-result`        | `tool-result`            | `part.output` → `payload.result`     |
 * | `finish-step`        | `step-finish`            | usage from `part.usage`              |
 * | `finish`             | `finish`                 | usage from `part.totalUsage`         |
 */
export function adaptStreamResult(
  result: ReturnType<typeof streamText> | StreamLike,
): MastraAgentStreamOutput {
  return {
    fullStream: adaptFullStream(result),
    // result.usage is a PromiseLike — wrap in Promise for interface compatibility
    usage: Promise.resolve(result.usage).then(usage => {
      const resolved = (usage ?? {}) as UsageLike;
      return {
        inputTokens: resolved.inputTokens,
        outputTokens: resolved.outputTokens,
      };
    }),
  };
}

async function* adaptFullStream(
  result: ReturnType<typeof streamText> | StreamLike,
): AsyncGenerator<MastraStreamEvent> {
  for await (const rawPart of result.fullStream) {
    const part = rawPart as StreamPartLike;
    switch (part.type) {
      case 'text-delta':
        yield {
          type: 'text-delta',
          payload: {
            // Mastra native: payload.text; AI SDK v6: part.text
            text: part.payload?.text ?? part.text ?? '',
            id: part.payload?.id ?? part.id ?? '',
          },
        };
        break;

      case 'tool-call':
        yield {
          type: 'tool-call',
          payload: {
            toolCallId: part.toolCallId ?? part.payload?.toolCallId,
            toolName: part.toolName ?? part.payload?.toolName,
            // `handleStream` reads `payload.args`; AI SDK v6 calls this `input`;
            // Mastra native stream has it under payload.args
            args: part.input ?? part.payload?.args,
          },
        };
        break;

      case 'tool-result':
        yield {
          type: 'tool-result',
          payload: {
            toolCallId: part.toolCallId ?? part.payload?.toolCallId,
            toolName: part.toolName ?? part.payload?.toolName,
            // Mastra native stream: payload.result; AI SDK v6 stream: part.output
            result:
              part.payload?.result !== undefined
                ? part.payload.result
                : part.output,
            args: part.input ?? part.payload?.args,
          },
        };
        break;

      case 'finish-step':
      case 'step-finish': {
        // Mastra native: {type:'step-finish', payload:{output:{usage:{...}}}}
        // AI SDK v6:     {type:'finish-step', usage:{...}}
        const sfUsage: UsageLike =
          part.payload?.output?.usage ?? part.usage ?? {};
        yield {
          type: 'step-finish',
          payload: {
            output: {
              usage: {
                inputTokens: sfUsage.inputTokens,
                outputTokens: sfUsage.outputTokens,
              },
            },
          },
        };
        break;
      }

      case 'finish': {
        // Mastra native: payload.output.usage; AI SDK v6: part.totalUsage
        const fUsage: UsageLike =
          part.payload?.output?.usage ?? part.totalUsage ?? {};
        yield {
          type: 'finish',
          payload: {
            output: {
              usage: {
                inputTokens: fUsage.inputTokens,
                outputTokens: fUsage.outputTokens,
              },
            },
          },
        };
        break;
      }

      default:
        // Unknown event types are silently dropped
        break;
    }
  }
}

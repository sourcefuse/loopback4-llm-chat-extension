import {streamText} from 'ai';
import {MastraAgentStreamOutput, MastraStreamEvent} from '../../types';

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
  result: ReturnType<typeof streamText>,
): MastraAgentStreamOutput {
  return {
    fullStream: adaptFullStream(result),
    // result.usage is a PromiseLike — wrap in Promise for interface compatibility
    usage: Promise.resolve(result.usage).then(u => ({
      inputTokens: u?.inputTokens,
      outputTokens: u?.outputTokens,
    })),
  };
}

async function* adaptFullStream(
  result: ReturnType<typeof streamText>,
): AsyncGenerator<MastraStreamEvent> {
  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        yield {
          type: 'text-delta',
          payload: {text: part.text, id: (part as {id?: string}).id ?? ''},
        };
        break;

      case 'tool-call':
        yield {
          type: 'tool-call',
          payload: {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            // `handleStream` reads `payload.args`; AI SDK v6 calls this `input`
            args: part.input,
          },
        };
        break;

      case 'tool-result':
        yield {
          type: 'tool-result',
          payload: {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            // `handleStream` reads `payload.result`; AI SDK v6 calls this `output`
            result: part.output,
            args: part.input,
          },
        };
        break;

      case 'finish-step':
        yield {
          type: 'step-finish',
          payload: {
            output: {
              usage: {
                inputTokens: part.usage?.inputTokens,
                outputTokens: part.usage?.outputTokens,
              },
            },
          },
        };
        break;

      case 'finish':
        yield {
          type: 'finish',
          payload: {
            output: {
              usage: {
                inputTokens: part.totalUsage?.inputTokens,
                outputTokens: part.totalUsage?.outputTokens,
              },
            },
          },
        };
        break;

      default:
        // Unknown event types are silently dropped
        break;
    }
  }
}

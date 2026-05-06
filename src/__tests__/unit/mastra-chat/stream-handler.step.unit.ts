import {expect} from '@loopback/testlab';
import {handleStream} from '../../../mastra/chat/steps/stream-handler.step';
import {mastraRequestWriterStore} from '../../../mastra/request-tool-store';
import {LLMStreamEventType, ToolStatus} from '../../../types/events';

class DummyTool {
  key = 'my-tool';
}

async function collectNonLogEvents(
  iter: AsyncGenerator<{
    type: LLMStreamEventType;
    data: unknown;
  }>,
) {
  const out: Array<{type: LLMStreamEventType; data: unknown}> = [];
  for await (const ev of iter) {
    if (ev.type !== LLMStreamEventType.Log) out.push(ev);
  }
  return out;
}

describe('handleStream (Mastra chat)', function () {
  const chatId = 'chat-1';

  const tools = {
    list: [new DummyTool()],
    map: {},
  };

  const chatStore = {
    addAIMessage: async () => 'ai-msg-id',
    addToolMessage: async () => undefined,
  };

  it('emits Tool -> ToolStatus -> Message when tool status is produced internally', async () => {
    const agentStream = {
      fullStream: (async function* () {
        yield {type: 'text-delta', payload: {text: 'before '}};
        yield {
          type: 'tool-call',
          payload: {
            toolCallId: 'tc-1',
            toolName: 'DummyTool',
            args: {q: 'x'},
          },
        };
        mastraRequestWriterStore.get(chatId)?.({
          type: LLMStreamEventType.ToolStatus,
          data: {status: 'Working'},
        } as never);
        yield {type: 'text-delta', payload: {text: 'after'}};
        yield {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-1',
            toolName: 'DummyTool',
            result: {ok: true},
          },
        };
        yield {
          type: 'step-finish',
          payload: {output: {usage: {inputTokens: 1, outputTokens: 2}}},
        };
      })(),
      usage: Promise.resolve({inputTokens: 1, outputTokens: 2}),
    };

    const events = await collectNonLogEvents(
      handleStream({
        agentStream: agentStream as never,
        abort: new AbortController().signal,
        tools: tools as never,
        chatId,
        chatStore: chatStore as never,
        tokens: {input: 0, output: 0, map: {}},
      }),
    );

    expect(events.map(e => e.type)).to.deepEqual([
      LLMStreamEventType.Tool,
      LLMStreamEventType.ToolStatus,
      LLMStreamEventType.Message,
    ]);
    expect((events[1].data as {id: string}).id).to.equal('tc-1');
    expect((events[2].data as {message: string}).message).to.equal(
      'before after',
    );
  });

  it('emits fallback ToolStatus on tool-result when no internal tool-status exists', async () => {
    const agentStream = {
      fullStream: (async function* () {
        yield {
          type: 'tool-call',
          payload: {
            toolCallId: 'tc-2',
            toolName: 'DummyTool',
            args: {},
          },
        };
        yield {
          type: 'tool-result',
          payload: {
            toolCallId: 'tc-2',
            toolName: 'DummyTool',
            result: {error: true},
          },
        };
        yield {
          type: 'step-finish',
          payload: {output: {usage: {inputTokens: 1, outputTokens: 1}}},
        };
      })(),
      usage: Promise.resolve({inputTokens: 1, outputTokens: 1}),
    };

    const events = await collectNonLogEvents(
      handleStream({
        agentStream: agentStream as never,
        abort: new AbortController().signal,
        tools: tools as never,
        chatId,
        chatStore: chatStore as never,
        tokens: {input: 0, output: 0, map: {}},
      }),
    );

    expect(events.map(e => e.type)).to.deepEqual([
      LLMStreamEventType.Tool,
      LLMStreamEventType.ToolStatus,
    ]);
    expect((events[1].data as {id: string}).id).to.equal('tc-2');
    expect((events[1].data as {status: string}).status).to.equal(
      ToolStatus.Failed,
    );
  });
});

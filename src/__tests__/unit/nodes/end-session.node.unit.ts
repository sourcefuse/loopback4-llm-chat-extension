import {LLMResult} from '@langchain/core/outputs';
import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {
  ChatState,
  ChatStore,
  EndSessionNode,
  LLMStreamEventType,
  RunnableConfig,
} from '../../../graphs';
import {TokenCounter} from '../../../services';

describe('EndSessionNode Unit', function () {
  let node: EndSessionNode;
  let chatStore: StubbedInstanceWithSinonAccessor<ChatStore>;

  beforeEach(async () => {
    chatStore = createStubInstance(ChatStore);
    const counter = new TokenCounter();
    node = new EndSessionNode(chatStore, counter);
    counter.handleLlmEnd({
      generations: [
        [
          {
            message: {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              usage_metadata: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                input_tokens: 10,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                output_tokens: 5,
              },
            },
          },
        ],
      ],
    } as unknown as LLMResult);
  });

  it('should update token counts and return the state, and update the chat counter', async () => {
    const state = {
      id: 'test-session-id',
      prompt: 'test prompt',
      messages: [],
      done: false,
      userMessage: undefined,
      aiMessage: undefined,
      files: undefined,
    } as ChatState;

    const writerStub = sinon.stub();
    const config = {
      writer: writerStub,
    } as unknown as RunnableConfig;

    const result = await node.execute(state, config);

    expect(result).to.equal(state);
    const writerCalls = writerStub.getCalls();
    expect(writerCalls).to.have.length(1);
    expect(writerCalls[0].args).to.deepEqual([
      {
        type: LLMStreamEventType.TokenCount,
        data: {
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    ]);

    const calls = chatStore.stubs.updateCounts.getCalls();
    expect(calls[0].args).to.deepEqual(['test-session-id', 10, 5]);
  });
});

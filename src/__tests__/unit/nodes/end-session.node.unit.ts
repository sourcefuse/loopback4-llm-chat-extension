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
    // first llm call
    counter.handleLlmStart('1', 'test');
    counter.handleLlmEnd('1', {
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
    // second llm call
    counter.handleLlmStart('2', 'test-2');
    counter.handleLlmEnd('2', {
      generations: [
        [
          {
            message: {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              usage_metadata: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                input_tokens: 20,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                output_tokens: 30,
              },
            },
          },
        ],
      ],
    } as unknown as LLMResult);
    node = new EndSessionNode(chatStore, counter);
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
          // sum of 10 and 20 from the two calls above
          inputTokens: 30,
          // sum of 5 and 30 from the two calls above
          outputTokens: 35,
        },
      },
    ]);

    const calls = chatStore.stubs.updateCounts.getCalls();
    expect(calls[0].args).to.deepEqual([
      'test-session-id',
      30,
      35,
      // model wise map of token counts
      {
        test: {inputTokens: 10, outputTokens: 5},
        'test-2': {inputTokens: 20, outputTokens: 30},
      },
    ]);
  });
});

import {AIMessage} from '@langchain/core/messages';
import {expect} from '@loopback/testlab';
import {ContextCompressionNode} from '../../../graphs';

describe(`ContextCompressionNode Unit`, function () {
  let node: ContextCompressionNode;

  beforeEach(() => {
    node = new ContextCompressionNode({
      maxTokenCount: 15,
    });
  });

  it('should not compress context if within limit', async () => {
    const state = {
      prompt: 'test prompt',
      // approx 13 tokens
      context: ['This is a long context that needs to be compressed.'],
      id: 'test-id',
      done: false,
      userMessage: undefined,
      aiMessage: undefined,
      messages: [
        new AIMessage({
          content: 'This is a long context that needs to be compressed',
        }),
      ],
      files: undefined,
    };

    const result = await node.execute(state, {});

    // no changes in messages as limit is not reached
    expect(result.messages).to.have.length(1);
  });

  it('should compress context if not within limit', async () => {
    const state = {
      prompt: 'test prompt',
      // approx 13 tokens
      context: ['This is a long context that needs to be compressed.'],
      id: 'test-id',
      done: false,
      userMessage: undefined,
      aiMessage: undefined,
      messages: [
        new AIMessage({
          content: 'This is a first context that needs to be compressed',
        }),
        new AIMessage({
          content: 'This is a second context that needs to be compressed',
        }),
        new AIMessage({
          content: 'This is a third context that needs to be compressed',
        }),
      ],
      files: undefined,
    };

    const result = await node.execute(state, {});

    // should only have the last message after compression
    expect(result.messages).to.have.length(1);

    expect(result.messages[0].text).to.eql(
      'This is a third context that needs to be compressed',
    );
  });
});

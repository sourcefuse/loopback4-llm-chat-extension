import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {
  ChatState,
  ChatStore,
  InitSessionNode,
  LLMStreamEventType,
} from '../../../graphs';
import {Chat} from '../../../models';

describe(`InitSessionNode Unit`, function () {
  let node: InitSessionNode;
  let chatStore: StubbedInstanceWithSinonAccessor<ChatStore>;

  beforeEach(() => {
    chatStore = createStubInstance(ChatStore);
    node = new InitSessionNode(chatStore);
  });

  it('should initialize a new chat session', async () => {
    const writerStub = sinon.stub();
    chatStore.stubs.init.callsFake(async () => {
      return new Chat({
        id: 'test-session-id',
      });
    });
    const result = await node.execute(
      {prompt: 'Hello'} as unknown as ChatState,
      {
        writer: writerStub,
      },
    );
    expect(result).to.have.property('id', 'test-session-id');
    expect(writerStub.calledOnce).to.be.true();
    expect(writerStub.getCalls()[0].args[0]).to.deepEqual({
      type: LLMStreamEventType.Init,
      data: {
        sessionId: 'test-session-id',
      },
    });
  });
});

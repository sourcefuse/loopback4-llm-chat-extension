import {HttpErrors} from '@loopback/rest';
import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {
  ChatState,
  ChatStore,
  humanMessage,
  SummariseFileNode,
} from '../../../graphs';
import {Message} from '../../../models';
import {buildFileStub, createMockLLM, MockLLM} from '../../test-helper';

describe(`SummariseFileNode Unit`, function () {
  let node: SummariseFileNode;
  let llm: MockLLM;
  let chatStore: StubbedInstanceWithSinonAccessor<ChatStore>;
  let writerStub: sinon.SinonStub;
  const dummyState: ChatState = {
    id: 'test-session-id',
    prompt: 'test prompt',
    messages: [],
    userMessage: new Message(),
    aiMessage: undefined,
    files: undefined,
  };

  beforeEach(() => {
    llm = createMockLLM();
    writerStub = sinon.stub();
    chatStore = createStubInstance(ChatStore);
    node = new SummariseFileNode(llm.model, chatStore);
  });

  it('should throw an error if no chat ID is found in state', async () => {
    await expect(
      node.execute({} as ChatState, {writer: writerStub}),
    ).to.be.rejectedWith(new HttpErrors.InternalServerError());
  });

  it('should throw an error if no last user message is found in state', async () => {
    await expect(
      node.execute({id: 'test-id'} as ChatState, {writer: writerStub}),
    ).to.be.rejectedWith(new HttpErrors.InternalServerError());
  });

  it('should return the state with human message if no file is provided', async () => {
    const result = await node.execute(
      {
        ...dummyState,
        files: [],
        prompt: 'test prompt',
      },
      {
        writer: writerStub,
      },
    );

    expect(result).to.deepEqual({
      ...dummyState,
      files: [],
      messages: [humanMessage('test prompt')],
    });
  });

  it('should return the state with human message if file is undefined', async () => {
    const result = await node.execute(
      {
        ...dummyState,
        files: undefined,
        prompt: 'test prompt',
      },
      {
        writer: writerStub,
      },
    );

    expect(result).to.deepEqual({
      ...dummyState,
      messages: [humanMessage('test prompt')],
      files: [],
    });
  });

  it('should the state with no file and a human message if 1 file is provided', async () => {
    llm.setText('This is a summary of the file.');
    const file = buildFileStub();
    const result = await node.execute(
      {
        ...dummyState,
        files: [file],
      },
      {
        writer: writerStub,
      },
    );

    expect(result).to.deepEqual({
      ...dummyState,
      files: [],
      prompt: `test prompt\nsummary of file - ${file.originalname}:\nThis is a summary of the file.`,
      messages: [
        humanMessage(
          `test prompt\nsummary of file - ${file.originalname}:\nThis is a summary of the file.`,
        ),
      ],
    });
  });

  it('should return the state with 1 file and no human message if 2 files are provided', async () => {
    llm.setText('This is a summary of the file.');
    const file1 = buildFileStub();
    const file2 = buildFileStub();
    const result = await node.execute(
      {
        ...dummyState,
        files: [file1, file2],
      },
      {
        writer: writerStub,
      },
    );

    expect(result).to.deepEqual({
      ...dummyState,
      files: [file2],
      prompt: `test prompt\nsummary of file - ${file1.originalname}:\nThis is a summary of the file.`,
      messages: [],
    });
  });
});

import {AIMessage, ToolMessage} from '@langchain/core/messages';
import {HttpErrors} from '@loopback/rest';
import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab'; // Changed import
import {Message} from '@sourceloop/chat-service';
import {ChatStore} from '../../../graphs/chat/chat.store';
import {RunToolNode} from '../../../graphs/chat/nodes/run-tool.node';
import {ChatState} from '../../../graphs/state';
import {IGraphTool, RunnableConfig} from '../../../graphs/types';
import {ToolStore} from '../../../types';

describe('RunToolNode Unit', () => {
  let runToolNode: RunToolNode;
  let tools: ToolStore;
  let chatStore: StubbedInstanceWithSinonAccessor<ChatStore>;
  let writerStub: sinon.SinonStub;
  let invokeStub: sinon.SinonStub;

  beforeEach(() => {
    writerStub = sinon.stub();
    invokeStub = sinon.stub();
    const dummyTool = {
      testTool: {
        build: sinon.stub().resolves({
          // Changed to sinon.stub()
          invoke: invokeStub.resolves('tool output'), // Changed to sinon.stub()
        }),
      } as unknown as IGraphTool,
    };
    tools = {
      map: dummyTool,
      list: Object.values(dummyTool),
    };
    chatStore = createStubInstance(ChatStore);
    runToolNode = new RunToolNode(tools, chatStore);
  });

  it('should return the state if the last message does not have tool_calls', async () => {
    const state = {
      id: 'testId',
      aiMessage: new Message(),
      messages: [new AIMessage({content: 'hello'})],
    } as unknown as ChatState;
    const config = {} as RunnableConfig;
    const result = await runToolNode.execute(state, config);
    expect(result).to.equal(state); // Changed to equal
  });

  it('should return the state if no messages', async () => {
    const state = {
      id: 'testId',
      messages: [],
      aiMessage: new Message(),
    } as unknown as ChatState;
    const config = {} as RunnableConfig;
    const result = await runToolNode.execute(state, config);
    expect(result).to.equal(state); // Changed to equal
  });

  it('should throw an error if no chat ID found in state', async () => {
    const state = {
      messages: [new AIMessage({content: 'hello'})],
      aiMessage: new Message(),
    } as unknown as ChatState;
    const config = {} as RunnableConfig;
    await expect(runToolNode.execute(state, config)).to.be.rejectedWith(
      new HttpErrors.InternalServerError(),
    );
  });

  it('should throw an error if no last AI message found in state', async () => {
    const state = {
      id: 'testId',
      messages: [],
    } as unknown as ChatState;
    const config = {} as RunnableConfig;
    await expect(runToolNode.execute(state, config)).to.be.rejectedWith(
      new HttpErrors.InternalServerError(),
    );
  });

  it('should call the tool with the correct arguments and add the ToolMessage to the chat store', async () => {
    const state: ChatState = {
      id: 'testId',
      messages: [
        new AIMessage({
          content: 'hello',
          // eslint-disable-next-line @typescript-eslint/naming-convention
          tool_calls: [
            {
              id: 'toolCallId',
              name: 'testTool',
              args: {input: 'test input'},
            },
          ],
        }),
      ],
      aiMessage: new AIMessage({content: 'hello'}),
    } as unknown as ChatState;
    const config = {
      writer: writerStub,
    } as unknown as RunnableConfig;
    const result = await runToolNode.execute(state, config);
    sinon.assert.calledWith(invokeStub, {
      input: 'test input',
    });
    const calls = chatStore.stubs.addToolMessage.getCalls();
    expect(calls).to.have.length(1);
    expect(calls[0].args[0]).to.equal('testId');
    expect(calls[0].args[1]).to.be.instanceOf(ToolMessage);
    expect(calls[0].args[1].name).to.equal('testTool');
    expect(result.messages).to.deepEqual([
      new ToolMessage({
        name: 'testTool',
        content: 'tool output',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        tool_call_id: 'toolCallId',
      }),
    ]);
  });
});

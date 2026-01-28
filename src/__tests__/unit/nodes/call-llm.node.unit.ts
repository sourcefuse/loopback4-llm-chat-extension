import {Context} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {expect, sinon} from '@loopback/testlab';
import {AuthenticationBindings} from 'loopback4-authentication';
import {CallLLMNode, ChatStore, RunnableConfig} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {Chat} from '../../../models';
import {ChatRepository, MessageRepository} from '../../../repositories';
import {LLMProvider} from '../../../types';
import {setupChats, setupMessages, stubUser} from '../../test-helper';

describe('CallLLMNode Unit', function () {
  let node: CallLLMNode;
  let bindToolsStub: sinon.SinonStub;
  let llmStub: sinon.SinonStub;
  let chatStore: ChatStore;
  let baseChat: Chat;
  beforeEach(async () => {
    bindToolsStub = sinon.stub();
    llmStub = sinon.stub();
    const llmProvider = {
      bindTools: bindToolsStub.callsFake(() => {
        return {
          invoke: llmStub,
        };
      }),
    } as unknown as LLMProvider;
    const context = new Context('test-context');
    context.bind('services.CallLLMNode').toClass(CallLLMNode);
    context.bind('services.ChatStore').toClass(ChatStore);
    context.bind('repositories.ChatRepository').toClass(ChatRepository);
    context.bind('repositories.MessageRepository').toClass(MessageRepository);
    context.bind(AiIntegrationBindings.Tools).to({
      list: [],
      map: {},
    });
    context.bind(AuthenticationBindings.CURRENT_USER).to(stubUser());
    context.bind(AiIntegrationBindings.SmartLLM).to(llmProvider);
    context.bind(AiIntegrationBindings.CheapLLM).to(llmProvider);
    context.bind(AiIntegrationBindings.ChatLLM).to(llmProvider);
    context.bind('datasources.readerdb').to(
      new juggler.DataSource({
        connector: 'sqlite3',
        file: ':memory:',
        name: 'db',
        debug: true,
      }),
    );
    context.bind(`datasources.writerdb`).to(
      new juggler.DataSource({
        connector: 'memory',
        name: 'db',
      }),
    );

    await setupChats(context);
    await setupMessages(context);

    node = await context.get<CallLLMNode>(`services.CallLLMNode`);

    chatStore = await context.get<ChatStore>(`services.ChatStore`);
    baseChat = await chatStore.init(`test`);
  });

  it('should call llm with all tools, and add response to messages list, and update chat state', async () => {
    llmStub.resolves({
      content: 'This is a response from LLM',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      tool_calls: [],
    });
    await node.execute(
      {
        id: baseChat.id,
        prompt: 'test prompt',
        messages: [],
        files: [],
        userMessage: undefined,
        aiMessage: undefined,
      },
      {
        writer: sinon.stub(),
      } as unknown as RunnableConfig,
    );

    expect(bindToolsStub.calledOnceWith([])).to.be.true();
    const chat = await chatStore.findById(baseChat.id, {
      include: ['messages'],
    });
    // should have added a message from LLM
    expect(chat).to.have.property('messages');
    expect(chat.messages).to.have.length(1);
    expect(chat.messages[0]).to.have.property(
      'body',
      'This is a response from LLM',
    );
    expect(chat.messages[0].metadata).to.deepEqual({
      type: 'ai',
    });
  });
});

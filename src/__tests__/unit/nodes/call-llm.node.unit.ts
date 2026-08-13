import {Context} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {expect, sinon} from '@loopback/testlab';
import {AuthenticationBindings} from 'loopback4-authentication';
import {
  CallLLMNode,
  ChatStore,
  humanMessage,
  RunnableConfig,
} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {Chat} from '../../../models';
import {ChatRepository, MessageRepository} from '../../../repositories';
import {LlmService} from '../../../services/llm.service';
import {
  createMockLLM,
  MockLLM,
  setupChats,
  setupMessages,
  stubUser,
} from '../../test-helper';

describe('CallLLMNode Unit', function () {
  let node: CallLLMNode;
  let llm: MockLLM;
  let chatStore: ChatStore;
  let baseChat: Chat;
  beforeEach(async () => {
    llm = createMockLLM();
    const llmProvider = llm.model;
    const context = new Context('test-context');
    context.bind('services.CallLLMNode').toClass(CallLLMNode);
    context.bind('services.LlmService').toClass(LlmService);
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
    llm.setText('This is a response from LLM');
    await node.execute(
      {
        id: baseChat.id,
        prompt: 'test prompt',
        messages: [humanMessage('test prompt')],
        files: [],
        userMessage: undefined,
        aiMessage: undefined,
      },
      {
        writer: sinon.stub(),
      } as unknown as RunnableConfig,
    );

    // The node no longer calls `bindTools`; it builds tools from the tool
    // store (empty here) and calls the model once via the AI SDK.
    expect(llm.calls).to.equal(1);
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

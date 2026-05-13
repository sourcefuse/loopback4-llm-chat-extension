import {AIMessage, HumanMessage, ToolMessage} from '@langchain/core/messages';
import {BindingScope, Getter, inject, injectable} from '@loopback/core';
import {
  AnyObject,
  Filter,
  FilterExcludingWhere,
  repository,
} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {CHAT_TITLE_MAX_LENGTH} from '../../constant';
import {Chat, Message} from '../../models';
import {ChatRepository} from '../../repositories';
import {ChannelType, TokenMetadata} from '../../types';
import {getTextContent, mergeAttachments} from '../../utils';
import {SavedMessage} from '../types';
import {CoreMessageLike} from '../../mastra/bridge/context-window-manager';
import {
  MessageMetadata,
  MessageMetadataType,
  ToolMessageMetadata,
} from './chat-metadata.type';

@injectable({scope: BindingScope.REQUEST})
export class ChatStore {
  constructor(
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    private readonly getCurrentUser: Getter<IAuthUserWithPermissions>,
    @repository(ChatRepository)
    private readonly chatRepository: ChatRepository,
  ) {}

  async findById(
    id: string,
    filter?: FilterExcludingWhere<Chat>,
  ): Promise<Chat> {
    const updatedFilter = await this._updateFilterWithUserId(filter);
    return this.chatRepository.findById(id, updatedFilter);
  }

  async find(filter?: Filter<Chat>) {
    const updatedFilter = await this._updateFilterWithUserId(filter);
    return this.chatRepository.find(updatedFilter);
  }

  async updateCounts(
    chatId: string,
    inputTokens: number,
    outputTokens: number,
    newCountMap: TokenMetadata,
  ) {
    const existingChat = await this.chatRepository.findById(chatId);
    return this.chatRepository.updateById(chatId, {
      inputTokens: existingChat.inputTokens + inputTokens,
      outputTokens: existingChat.outputTokens + outputTokens,
      metadata: this.mergeCountMap(existingChat.metadata, newCountMap),
    });
  }

  async init(prompt: string, threadId?: string): Promise<Chat & {id: string}> {
    if (threadId) {
      return this.chatRepository.findById(threadId, {
        include: [
          {
            relation: 'messages',
            scope: {
              include: ['messages'],
              order: ['createdOn ASC'],
            },
          },
        ],
      });
    } else {
      const currentUser = await this.getCurrentUser();
      if (!currentUser) {
        throw new HttpErrors.Unauthorized(
          'User not authenticated or permissions not found',
        );
      }
      return this.chatRepository.create({
        tenantId: currentUser.tenantId,
        userId: currentUser.userTenantId,
        inputTokens: 0,
        outputTokens: 0,
        title: prompt?.slice(0, CHAT_TITLE_MAX_LENGTH) ?? 'New Chat',
        metadata: {},
      });
    }
  }

  async addMessage(
    chatId: string,
    message: string,
    metadata: MessageMetadata,
    fromAi = false,
    parentMessageId?: string,
  ) {
    const currentUser = await this.getCurrentUser();
    if (!currentUser) {
      throw new HttpErrors.Unauthorized(
        'User not authenticated or permissions not found',
      );
    }
    const newMessage = await this.chatRepository.messages(chatId).create({
      channelId: chatId,
      body: message,
      metadata,
      channelType: ChannelType.Chat,
      toUserId: fromAi ? currentUser.userTenantId : undefined,
      parentMessageId,
    });
    return newMessage;
  }

  /**
   * Find a message entity by its ID within a chat session.
   * Used by FileProcessingStep to retrieve the user Message for addAttachmentMessage.
   */
  async findMessageById(
    chatId: string,
    messageId: string,
  ): Promise<Message | undefined> {
    try {
      return await this.chatRepository
        .messages(chatId)
        .find({
          where: {id: messageId},
          limit: 1,
        })
        .then(results => results[0]);
    } catch {
      return undefined;
    }
  }

  /**
   * Load all messages for a session, including nested sub-messages.
   * Used by PrepareContextStep to build the full conversation context.
   */
  async getMessages(chatId: string): Promise<Message[]> {
    const chat = await this.chatRepository.findById(chatId, {
      include: [
        {
          relation: 'messages',
          scope: {
            include: ['messages'],
            order: ['createdOn ASC'],
          },
        },
      ],
    });
    return chat.messages ?? [];
  }

  async addHumanMessage(chatId: string, message: HumanMessage) {
    return this.addMessage(chatId, getTextContent(message.content), {
      type: MessageMetadataType.User,
    });
  }

  /**
   * Mastra-compatible variant of addHumanMessage that accepts a plain string.
   * Used by the ChatWorkflow's InitSessionStep without LangChain dependencies.
   */
  async addHumanMessageText(chatId: string, text: string) {
    return this.addMessage(chatId, text, {
      type: MessageMetadataType.User,
    });
  }

  /**
   * Mastra-compatible variant of addAIMessage that accepts a plain string.
   * Used by the ChatWorkflow's PersistConversationStep without LangChain dependencies.
   */
  async addAIMessageText(chatId: string, text: string) {
    const body = text.trim() || ' ';
    return this.addMessage(
      chatId,
      body,
      {
        type: MessageMetadataType.AI,
      },
      true,
    );
  }

  /**
   * Mastra-compatible variant of addToolMessage that accepts plain strings/objects.
   * Used by the ChatWorkflow's PersistConversationStep without LangChain dependencies.
   */
  async addToolMessageText(
    chatId: string,
    toolCallId: string,
    toolName: string,
    content: string,
    metadata: AnyObject,
    aiMessage: Message,
    args?: AnyObject,
  ) {
    return this.addMessage(
      chatId,
      content,
      {
        type: MessageMetadataType.Tool,
        toolName,
        id: toolCallId,
        args,
        ...metadata,
      },
      true,
      aiMessage.id,
    );
  }

  async addAttachmentMessage(
    chatId: string,
    userMessage: Message,
    file: Express.Multer.File,
    summary: string,
  ) {
    return this.addMessage(
      chatId,
      summary,
      {
        type: MessageMetadataType.Attachment,
        fileName: file.originalname,
        fileSize: file.size,
        messageId: userMessage.id!,
        summary,
      },
      true,
      userMessage.id,
    );
  }

  async addAIMessage(chatId: string, message: AIMessage) {
    let text = getTextContent(message.content);
    if (!text.trim()) {
      // empty message incase the LLM only returns tool calls
      text = ' ';
    }
    return this.addMessage(
      chatId,
      text,
      {
        type: MessageMetadataType.AI,
      },
      true,
    );
  }

  async addToolMessage(
    chatId: string,
    message: ToolMessage,
    metadata: AnyObject,
    aiMessage: Message,
    args?: AnyObject,
  ) {
    return this.addMessage(
      chatId,
      getTextContent(message.content),
      {
        type: MessageMetadataType.Tool,
        toolName: message.name!,
        id: message.tool_call_id,
        args,
        ...metadata,
      },
      true,
      aiMessage.id,
    );
  }

  async toMessage(message: Message): Promise<SavedMessage | undefined> {
    if (message.metadata?.type === MessageMetadataType.User) {
      let messageContent = message.body;
      for (const fileMessage of message.messages ?? []) {
        if (fileMessage.metadata?.type === MessageMetadataType.Attachment) {
          messageContent = mergeAttachments(
            messageContent,
            fileMessage.metadata.fileName,
            fileMessage.body,
          );
        }
      }
      return new HumanMessage({
        content: messageContent,
      });
    } else if (message.metadata?.type === MessageMetadataType.AI) {
      const newMessage = new AIMessage(message.body.trim() ?? undefined);
      newMessage.tool_calls =
        message.messages
          ?.filter(
            (
              v,
            ): v is Message & {
              metadata: ToolMessageMetadata;
            } => v.metadata.type === MessageMetadataType.Tool,
          )
          .map(msg => {
            return {
              id: msg.metadata.id,
              name: msg.metadata.toolName,
              args: msg.metadata.args ?? {},
            };
          }) ?? [];
      return newMessage;
    } else if (message.metadata?.type === MessageMetadataType.Tool) {
      return new ToolMessage({
        name: message.metadata.toolName,
        content: message.body,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        tool_call_id: message.metadata.id,
      });
    } else {
      // do nothing for other types
    }
  }

  /**
   * Convert a persisted Message entity to a CoreMessage-compatible object.
   * Used by PrepareContextStep to build the agent's conversation history.
   * Avoids LangChain types — compatible with Vercel AI SDK CoreMessage format.
   */
  async toCoreMessage(message: Message): Promise<CoreMessageLike | undefined> {
    if (message.metadata?.type === MessageMetadataType.User) {
      let messageContent = message.body;
      for (const fileMessage of message.messages ?? []) {
        if (fileMessage.metadata?.type === MessageMetadataType.Attachment) {
          messageContent = mergeAttachments(
            messageContent,
            fileMessage.metadata.fileName,
            fileMessage.body,
          );
        }
      }
      return {role: 'user', content: messageContent};
    } else if (message.metadata?.type === MessageMetadataType.AI) {
      const toolCalls = message.messages
        ?.filter(
          (v): v is Message & {metadata: ToolMessageMetadata} =>
            v.metadata.type === MessageMetadataType.Tool,
        )
        .map(msg => ({
          type: 'tool-call' as const,
          toolCallId: msg.metadata.id,
          toolName: msg.metadata.toolName,
          args: msg.metadata.args ?? {},
        }));

      if (toolCalls?.length) {
        return {
          role: 'assistant',
          content: [
            ...(message.body.trim()
              ? [{type: 'text' as const, text: message.body.trim()}]
              : []),
            ...toolCalls,
          ],
        };
      }
      return {role: 'assistant', content: message.body.trim() || ' '};
    } else if (message.metadata?.type === MessageMetadataType.Tool) {
      const toolMeta = message.metadata as ToolMessageMetadata;
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: toolMeta.id,
            toolName: toolMeta.toolName,
            result: message.body,
          },
        ],
      };
    }
    return undefined;
  }

  private mergeCountMap(metadata: TokenMetadata, newData: TokenMetadata) {
    const result: TokenMetadata = {...metadata};
    for (const key of Object.keys(newData)) {
      if (result[key]) {
        result[key].inputTokens += newData[key].inputTokens;
        result[key].outputTokens += newData[key].outputTokens;
      } else {
        result[key] = {...newData[key]};
      }
    }
    return result;
  }

  private async _updateFilterWithUserId(filter?: Filter<Chat>) {
    if (!filter) {
      filter = {};
    }
    const currentUser = await this.getCurrentUser();
    if (currentUser) {
      filter.where = {
        and: [
          filter.where ?? {},
          {userId: currentUser.userTenantId, tenantId: currentUser.tenantId},
        ],
      };
    }
    return filter;
  }
}

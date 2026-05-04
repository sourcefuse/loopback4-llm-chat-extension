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
import {CHAT_TITLE_MAX_LENGTH} from '../constant';
import {Chat, Message} from '../models';
import {ChatRepository} from '../repositories';
import {ChannelType, TokenMetadata} from '../types';
import {mergeAttachments} from '../utils';
import {MastraAgentMessage, MastraAssistantContentPart} from '../mastra/types';
import {
  MessageMetadata,
  MessageMetadataType,
  ToolMessageMetadata,
} from './chat-metadata.type';

/**
 * Plain-message type returned by `toMessage()`.
 * Compatible with AI SDK `CoreMessage` and Mastra `MastraAgentMessage`.
 */
export type SavedMessage = MastraAgentMessage;

/**
 * Persistence service for Chat and Message records.
 *
 * All methods that previously accepted/returned `@langchain/core/messages`
 * types (HumanMessage, AIMessage, ToolMessage) now use plain strings or
 * `MastraAgentMessage` — no @langchain dependency.
 */
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
   * Persists a human/user message to the DB.
   * Accepts a plain string instead of a `HumanMessage` instance.
   */
  async addHumanMessage(chatId: string, prompt: string) {
    return this.addMessage(chatId, prompt, {
      type: MessageMetadataType.User,
    });
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

  /**
   * Persists an AI message to the DB.
   * Accepts plain content + optional tool calls instead of an `AIMessage` instance.
   */
  async addAIMessage(
    chatId: string,
    content: string,
    toolCalls?: {id: string; name: string; args: AnyObject}[],
  ) {
    let text = content;
    if (!text.trim()) {
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

  /**
   * Persists a tool-result message to the DB.
   * Accepts structured parameters instead of a `ToolMessage` instance.
   */
  async addToolMessage(
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

  /**
   * Converts a DB `Message` row into a `MastraAgentMessage` (compatible with
   * AI SDK `CoreMessage`).  Returns `undefined` for unrecognised message types.
   */
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
      return {role: 'user', content: messageContent};
    } else if (message.metadata?.type === MessageMetadataType.AI) {
      const text = message.body.trim();
      const toolCalls =
        message.messages
          ?.filter(
            (v): v is Message & {metadata: ToolMessageMetadata} =>
              v.metadata.type === MessageMetadataType.Tool,
          )
          .map(msg => ({
            id: msg.metadata.id,
            name: msg.metadata.toolName,
            args: msg.metadata.args ?? {},
          })) ?? [];

      if (toolCalls.length > 0) {
        const parts: MastraAssistantContentPart[] = [];
        if (text) parts.push({type: 'text', text});
        for (const tc of toolCalls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.args as Record<string, unknown>,
          });
        }
        return {role: 'assistant', content: parts};
      }
      return {role: 'assistant', content: text};
    } else if (message.metadata?.type === MessageMetadataType.Tool) {
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.metadata.id,
            toolName: message.metadata.toolName,
            result: message.body,
          },
        ],
      };
    } else {
      return undefined;
    }
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

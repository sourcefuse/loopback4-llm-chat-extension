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
import {ChannelType} from '../../types';
import {getTextContent, mergeAttachments} from '../../utils';
import {SavedMessage} from '../types';
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
  ) {
    const existingChat = await this.chatRepository.findById(chatId);
    return this.chatRepository.updateById(chatId, {
      inputTokens: existingChat.inputTokens + inputTokens,
      outputTokens: existingChat.outputTokens + outputTokens,
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
      toUserId: fromAi ? currentUser.id : undefined,
      parentMessageId,
    });
    return newMessage;
  }

  async addHumanMessage(chatId: string, message: HumanMessage) {
    return this.addMessage(chatId, getTextContent(message.content), {
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

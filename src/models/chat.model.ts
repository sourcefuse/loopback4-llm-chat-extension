import {hasMany, model, property} from '@loopback/repository';
import {UserModifiableEntity} from '@sourceloop/core';
import {Message} from './message.model';

@model({
  name: 'chats',
})
export class Chat extends UserModifiableEntity {
  @property({
    type: 'string',
    id: true,
    description: 'Unique identifier for the chat thread',
  })
  id: string;

  @property({
    type: 'string',
    required: true,
    name: 'tenant_id',
  })
  tenantId: string;

  @property({
    type: 'string',
    required: true,
    name: 'user_id',
    description: 'ID of the user who initiated the chat',
  })
  userId: string;

  @property({
    type: 'string',
    required: true,
    name: 'title',
    description: 'Title of the chat session, can be used to identify the chat',
  })
  title: string;

  @property({
    type: 'number',
    name: 'input_tokens',
    description: 'Number of input tokens used in the chat',
  })
  inputTokens: number;

  @property({
    type: 'number',
    name: 'output_tokens',
    description: 'Number of output tokens generated in the chat',
  })
  outputTokens: number;

  @hasMany(() => Message, {keyTo: 'channelId'})
  messages: Message[];

  constructor(data?: Partial<Chat>) {
    super(data);
  }
}

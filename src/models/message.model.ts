import {hasMany, model, property} from '@loopback/repository';
import {Message as SourceloopMessage} from '@sourceloop/chat-service';
import {MessageMetadata} from '../services/chat-metadata.type';
@model({
  name: 'messages',
})
export class Message extends SourceloopMessage {
  @property({
    type: 'json',
    name: 'metadata',
    required: true,
  })
  metadata: MessageMetadata;

  @hasMany(() => Message, {keyTo: 'parentMessageId'})
  override messages: Message[];
}

import {AnyObject} from '@loopback/repository';

export enum MessageMetadataType {
  AI = 'ai',
  Tool = 'tool',
  User = 'user',
  System = 'system',
  Attachment = 'attachment',
}
export type AiMessageMetadata = {
  type: MessageMetadataType.AI;
};
export type UserMessageMetadata = {
  type: MessageMetadataType.User;
};
export type FileMessageMetadata = {
  type: MessageMetadataType.Attachment;
  fileName: string;
  fileSize: number;
  summary: string;
  messageId: string;
};
export type ToolMessageMetadata = {
  type: MessageMetadataType.Tool;
  toolName: string;
  id: string;
  status?: string; // Optional status for tool messages
  [key: string]: AnyObject[string]; // Allow additional metadata
};
export type MessageMetadata =
  | ToolMessageMetadata
  | AiMessageMetadata
  | FileMessageMetadata
  | UserMessageMetadata;

import {z} from 'zod';
import {Message} from '../models';
import type {ModelMessage} from './messages';

/**
 * Permissive zod schema used as the Mastra workflow `stateSchema` (the shared
 * "annotation" channel). Every field is optional so partial/initial states
 * validate; `catchall` prevents any field from being stripped. The exported
 * `ChatState` type below preserves the exact shape node code relies on.
 */
export const ChatGraphAnnotation = z
  .object({
    messages: z.array(z.custom<ModelMessage>()).optional(),
    id: z.string().optional(),
    files: z.array(z.custom<Express.Multer.File>()).optional(),
    prompt: z.string().optional(),
    userMessage: z.custom<Message>().optional(),
    aiMessage: z.custom<Message>().optional(),
  })
  .catchall(z.any());

export type ChatState = {
  messages: ModelMessage[];
  id: string | undefined;
  files: Express.Multer.File[] | undefined;
  prompt: string;
  userMessage: Message | undefined;
  aiMessage: Message | undefined;
};

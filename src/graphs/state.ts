import {Annotation, MessagesAnnotation} from '@langchain/langgraph';
import {Message} from '../models';

export const ChatGraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  id: Annotation<string | undefined>,
  files: Annotation<Express.Multer.File[] | undefined>,
  prompt: Annotation<string>,
  userMessage: Annotation<Message | undefined>,
  aiMessage: Annotation<Message | undefined>,
});
export type ChatState = typeof ChatGraphAnnotation.State;

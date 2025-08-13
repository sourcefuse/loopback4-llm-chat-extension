import {HumanMessage} from '@langchain/core/messages';
import {PromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {LangGraphRunnableConfig, Messages} from '@langchain/langgraph';
import {inject} from '@loopback/context';
import {service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {graphNode} from '../../../decorators';
import {AiIntegrationBindings} from '../../../keys';
import {LLMProvider} from '../../../types';
import {mergeAttachments, stripThinkingTokens} from '../../../utils';
import {LLMStreamEventType} from '../../event.types';
import {ChatState} from '../../state';
import {IGraphNode} from '../../types';
import {ChatStore} from '../chat.store';
import {ChatNodes} from '../nodes.enum';

const debug = require('debug')('ai-integration:chat:summarise-file.node');

@graphNode(ChatNodes.SummariseFile)
export class SummariseFileNode implements IGraphNode<ChatState> {
  constructor(
    @inject(AiIntegrationBindings.FileLLM)
    private readonly llm: LLMProvider,
    @service(ChatStore)
    private readonly chatStore: ChatStore,
  ) {}

  prompt =
    PromptTemplate.fromTemplate(`You are an AI assistant that summarizes file content keeping all the important details in mind.
  Make sure that you don't miss any important details and summarize the content in a concise manner.
  While summarizing the content, make sure that you keep the user's prompt in mind and summarize the content in a way that it can be used to answer the user's query.
  You will be provided with user's original prompt and one file among the files that user provided.
  You will summarize the one file at a time so don't worry about the other files mentioned in the user's prompt.
  The summary should be relatively short and only contain the important details that are relevant to the user's query.
  The output should just be a plain text string without any additional markdown syntax or any special formatting.
  Here is the user's prompt:
  {prompt}
  `);

  async execute(
    state: ChatState,
    config: LangGraphRunnableConfig,
  ): Promise<ChatState> {
    if (!state.id) {
      debug('No chat ID found in state, this is unexpected');
      throw new HttpErrors.InternalServerError();
    }
    if (!state.userMessage) {
      debug('No last user message found in state, this is unexpected');
      throw new HttpErrors.InternalServerError();
    }
    if (state.files && state.files.length > 0) {
      const file = state.files[0]; // Assuming we are only processing the first file for now, we'll iterate till this list is empty
      config.writer?.({
        type: LLMStreamEventType.Log,
        data: `Processing file: ${file.originalname}`,
      });
      config.writer?.({
        type: LLMStreamEventType.Status,
        data: `Reading file: ${file.originalname}`,
      });
      const fileContent = this.buildFileContent(file);
      const prompt: Messages = [
        {
          role: 'system',
          content: await this.prompt.format({
            prompt: state.prompt,
          }),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: state.prompt,
            },
            fileContent,
          ],
        },
      ];
      const chain = RunnableSequence.from([this.llm, stripThinkingTokens]);

      const summary = await chain.invoke(prompt);

      await this.chatStore.addAttachmentMessage(
        state.id,
        state.userMessage,
        file,
        summary,
      );

      const response = mergeAttachments(
        state.prompt,
        file.originalname,
        summary,
      );
      const newFiles = state.files.slice(1); // Remove the first file after processing
      if (newFiles.length > 0) {
        // If there are more files, we need to continue processing them
        return {
          ...state,
          prompt: response,
          files: newFiles,
        };
      } else {
        // If there are no more files, we can return the final state
        return {
          ...state,
          prompt: response,
          messages: [
            new HumanMessage({
              content: response,
            }),
          ],
          files: [],
        };
      }
    }

    // code should reach here if there were no files to process to begin with
    return {
      ...state,
      messages: [
        new HumanMessage({
          content: state.prompt,
        }),
      ],
      files: [],
    };
  }

  private buildFileContent(file: Express.Multer.File): AnyObject {
    if (this.llm.getFile) {
      return this.llm.getFile(file);
    } else {
      return {
        type: 'file',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        source_type: 'base64',
        data: file.buffer?.toString('base64') ?? '',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        mime_type: 'application/pdf',
      };
    }
  }
}

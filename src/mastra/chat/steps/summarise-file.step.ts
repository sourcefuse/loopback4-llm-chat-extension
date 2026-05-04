import {generateText} from 'ai';
import {ChatStore} from '../../../services/chat.store';
import {Message} from '../../../models';
import {LLMProvider} from '../../../types';
import {mergeAttachments} from '../../../utils';
import {stripThinkingFromText} from '../../db-query/utils/thinking.util';
import {TokenAccumulator} from '../types/chat.types';
import {accumulateUsage} from '../utils/token-accumulator.util';

const debug = require('debug')('mastra:chat:summarise-file');

/**
 * Parameters for `summariseOneFile`.
 */
export interface SummariseFileParams {
  file: Express.Multer.File;
  currentPrompt: string;
  chatId: string;
  userMessage: Message;
  /** Mutated in place — updated with file-summarisation token usage. */
  tokens: TokenAccumulator;
  fileLLM: LLMProvider;
  chatStore: ChatStore;
}

/**
 * Mirrors `SummariseFileNode` for a single file.
 *
 * Uses `generateText()` from the Vercel AI SDK instead of the LangChain
 * `BaseChatModel.invoke()` path. Persists the attachment message and returns
 * an updated prompt that embeds the summary.
 */
export async function summariseOneFile(
  params: SummariseFileParams,
): Promise<string> {
  const {file, currentPrompt, chatId, userMessage, tokens, fileLLM, chatStore} =
    params;

  debug('Summarising file: %s', file.originalname);
  debug('Prompt length: %d', currentPrompt.length);

  const fileData = file.buffer?.toString('base64') ?? '';

  const {text, usage} = await generateText({
    model: fileLLM,
    messages: [
      {
        role: 'user',
        content: [
          {type: 'text', text: buildFileSummaryPrompt(currentPrompt)},
          {
            type: 'file',
            data: fileData,
            mediaType: file.mimetype,
          },
        ],
      },
    ],
  });

  debug('Summary generated, tokens: %o', usage);

  accumulateUsage(
    {
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
    },
    'mastra-file',
    tokens,
  );

  const summary = stripThinkingFromText(text);
  await chatStore.addAttachmentMessage(chatId, userMessage, file, summary);
  return mergeAttachments(currentPrompt, file.originalname, summary);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildFileSummaryPrompt(userPrompt: string): string {
  return `You are an AI assistant that summarizes file content keeping all the important details in mind.
  Make sure that you don't miss any important details and summarize the content in a concise manner.
  While summarizing the content, make sure that you keep the user's prompt in mind and summarize the content in a way that it can be used to answer the user's query.
  You will be provided with user's original prompt and one file among the files that user provided.
  You will summarize the one file at a time so don't worry about the other files mentioned in the user's prompt.
  The summary should be relatively short and only contain the important details that are relevant to the user's query.
  The output should just be a plain text string without any additional markdown syntax or any special formatting.
  Here is the user's prompt:
  ${userPrompt}
  `;
}

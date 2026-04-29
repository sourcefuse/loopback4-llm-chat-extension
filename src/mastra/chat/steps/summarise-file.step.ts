import {AIMessage} from '@langchain/core/messages';
import {ChatStore} from '../../../graphs/chat/chat.store';
import {Message} from '../../../models';
import {resolveLegacyLLMProvider, RuntimeLLMProvider} from '../../../types';
import {mergeAttachments, stripThinkingTokens} from '../../../utils';
import {TokenAccumulator} from '../types/chat.types';
import {accumulateUsage} from '../utils/token-accumulator.util';

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
  fileLLM: RuntimeLLMProvider;
  chatStore: ChatStore;
}

/**
 * Mirrors `SummariseFileNode` for a single file.
 *
 * Invokes the file LLM to produce a concise summary of the file in the
 * context of the user prompt, persists the attachment message, and returns
 * an updated prompt that embeds the summary.
 */
export async function summariseOneFile(
  params: SummariseFileParams,
): Promise<string> {
  const {file, currentPrompt, chatId, userMessage, tokens, fileLLM, chatStore} =
    params;

  const llm = resolveLegacyLLMProvider(fileLLM);
  const fileContent = buildFileContent(file, fileLLM);
  const messages = [
    {
      role: 'system' as const,
      content: buildFileSummaryPrompt(currentPrompt),
    },
    {
      role: 'user' as const,
      content: [{type: 'text', text: currentPrompt}, fileContent],
    },
  ];

  const aiResponse = (await llm.invoke(messages)) as AIMessage;
  const usage = aiResponse.usage_metadata;
  if (usage) {
    accumulateUsage(
      {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
      },
      'mastra-file',
      tokens,
    );
  }

  const summary = stripThinkingTokens(aiResponse);
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

function buildFileContent(
  file: Express.Multer.File,
  fileLLM: RuntimeLLMProvider,
): object {
  if (fileLLM.getFile) {
    return fileLLM.getFile(file);
  }
  return {
    type: 'file',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    source_type: 'base64',
    data: file.buffer?.toString('base64') ?? '',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    mime_type: file.mimetype,
  };
}

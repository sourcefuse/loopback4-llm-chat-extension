// needed for z.infer in function signatures
import {z} from 'zod';
import {createStep} from '@mastra/core/workflows';
import {Agent} from '@mastra/core/agent';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {Readable} from 'stream';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {asWorkflowContext} from '../../../bridge/workflow-request-context';
import {mergeAttachments} from '../../../../utils';
import {Message} from '../../../../models';
import {
  PrepareContextOutputSchema,
  FileProcessingOutputSchema,
} from '../chat-workflow-schemas';

const debug = require('debug')('ai-integration:mastra:file-processing.step');

const FILE_SUMMARY_SYSTEM_PROMPT = `You are an AI assistant that summarizes file content keeping all the important details in mind.
Make sure that you don't miss any important details and summarize the content in a concise manner.
While summarizing the content, make sure that you keep the user's prompt in mind and summarize the content in a way that it can be used to answer the user's query.
You will be provided with user's original prompt and one file among the files that user provided.
You will summarize the one file at a time so don't worry about the other files mentioned in the user's prompt.
The summary should be relatively short and only contain the important details that are relevant to the user's query.
The output should just be a plain text string without any additional markdown syntax or any special formatting.`;

type FileContentPart = {
  type: 'file';
  // eslint-disable-next-line @typescript-eslint/naming-convention
  source_type: 'base64';
  data: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  mime_type: string;
};

type FileModelWithAdapter = MastraLanguageModel & {
  getFile?: (file: Express.Multer.File) => FileContentPart;
};

/**
 * FileProcessingStep — summarise uploaded files using the file LLM.
 *
 * LangGraph equivalent: `SummariseFileNode` (handles the full iteration loop).
 *
 * Responsibilities:
 *  - For each uploaded file, call the file LLM for a summary
 *  - Persist each summary as an Attachment message in the database
 *  - Replace the last user message in the context with an enhanced version
 *    that merges the original prompt with all file summaries
 *
 * If no files are present, messages and prompt pass through unchanged.
 */
export const fileProcessingStep = createStep({
  id: 'file-processing',
  description:
    'Summarise uploaded files and merge summaries into the conversation context',
  inputSchema: PrepareContextOutputSchema,
  outputSchema: FileProcessingOutputSchema,
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asWorkflowContext(requestContext);

    const {sessionId, messages, userMessageId, prompt, files} = inputData;

    if (!files?.length) {
      debug('FileProcessing: no files to process, passing through');
      return {sessionId, messages, userMessageId, prompt};
    }

    const chatStore = ctx.get('chatStore');
    const fileLlm = ctx.get('mastraFileLlm') as MastraLanguageModel | undefined;

    if (!fileLlm) {
      throw new Error(
        'MastraFileLLM not bound. Bind AiIntegrationBindings.MastraFileLLM to process files.',
      );
    }

    // Retrieve the saved user Message entity for addAttachmentMessage
    const userMessageRecord = userMessageId
      ? await chatStore.findMessageById(sessionId, userMessageId)
      : undefined;

    let mergedPrompt = prompt;

    for (const file of files) {
      const multerFile = toMulterFile(file);
      debug(`FileProcessing: processing file ${multerFile.originalname}`);

      // Emit Status via writer (workflow-native streaming, not AsyncEventQueue)
      await writer.write({
        type: LLMStreamEventType.Status,
        data: `Reading file: ${multerFile.originalname}`,
      });

      // Build the file content part for the LLM message
      const fileContentPart = buildFileContentPart(multerFile, fileLlm);

      // Use a one-shot Agent to summarise the file with the file LLM
      const summaryAgent = new Agent({
        id: 'file-summary-agent',
        name: 'File Summary Agent',
        instructions: `${FILE_SUMMARY_SYSTEM_PROMPT}\nHere is the user's prompt:\n${prompt}`,
        model: fileLlm,
      });

      const agentResult = await summaryAgent.generate([
        {
          role: 'user',
          content: [{type: 'text', text: prompt}, fileContentPart],
        },
      ]);

      const rawText = agentResult.text ?? '';
      const summary = typeof rawText === 'string' ? rawText : '';

      debug(`FileProcessing: file summary length=${summary.length}`);

      // Persist the attachment message to the database
      if (userMessageRecord) {
        await chatStore.addAttachmentMessage(
          sessionId,
          userMessageRecord as Message,
          multerFile,
          summary,
        );
      }

      // Merge the file summary into the running prompt
      mergedPrompt = mergeAttachments(
        mergedPrompt,
        multerFile.originalname,
        summary,
      );
    }

    // Replace the last user message in the context with the enhanced version
    const updatedMessages = replaceLastUserMessage(messages, mergedPrompt);

    return {
      sessionId,
      messages: updatedMessages as z.infer<
        typeof FileProcessingOutputSchema
      >['messages'],
      userMessageId,
      prompt: mergedPrompt,
    };
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function toMulterFile(
  file: z.infer<typeof PrepareContextOutputSchema>['files'][number],
): Express.Multer.File {
  const source = file as Record<string, unknown>;

  const buffer = Buffer.isBuffer(source.buffer)
    ? source.buffer
    : Buffer.alloc(0);
  const originalname =
    typeof source.originalname === 'string' && source.originalname.length > 0
      ? source.originalname
      : 'attachment';
  const mimetype =
    typeof source.mimetype === 'string' && source.mimetype.length > 0
      ? source.mimetype
      : 'application/pdf';
  const fieldname =
    typeof source.fieldname === 'string' && source.fieldname.length > 0
      ? source.fieldname
      : 'file';
  const encoding =
    typeof source.encoding === 'string' && source.encoding.length > 0
      ? source.encoding
      : '7bit';
  const size =
    typeof source.size === 'number' && Number.isFinite(source.size)
      ? source.size
      : buffer.length;

  return {
    fieldname,
    originalname,
    encoding,
    mimetype,
    size,
    destination: '',
    filename: originalname,
    path: '',
    buffer,
    stream: Readable.from(buffer),
  };
}

/**
 * Build a file content part compatible with the Vercel AI SDK message format.
 * Mirrors `SummariseFileNode.buildFileContent()`.
 */
function buildFileContentPart(
  file: Express.Multer.File,
  llm: MastraLanguageModel,
): FileContentPart {
  // Some LLM providers have a custom getFile() helper on the provider instance
  const provider = llm as FileModelWithAdapter;
  if (typeof provider?.getFile === 'function') {
    return provider.getFile(file);
  }
  return {
    type: 'file',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    source_type: 'base64',
    data: file.buffer?.toString('base64') ?? '',
    // eslint-disable-next-line @typescript-eslint/naming-convention
    mime_type: file.mimetype ?? 'application/pdf',
  };
}

/**
 * Replace the last user message with an enhanced version containing file summaries.
 */
function replaceLastUserMessage(
  messages: z.infer<typeof PrepareContextOutputSchema>['messages'],
  enhancedPrompt: string,
): z.infer<typeof PrepareContextOutputSchema>['messages'] {
  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx < 0) {
    return [...messages, {role: 'user', content: enhancedPrompt}];
  }

  const updated = [...messages];
  updated[lastUserIdx] = {role: 'user', content: enhancedPrompt};
  return updated;
}

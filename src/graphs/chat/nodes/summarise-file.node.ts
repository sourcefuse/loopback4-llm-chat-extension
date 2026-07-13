import debugFactory from 'debug';
import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import type {MastraModelConfig} from '@mastra/core/llm';
import {generateText, type LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import {AiIntegrationBindings} from '../../../keys';
import {LLMStreamEvent, LLMStreamEventType} from '../../event.types';
import type {ChatState, IChatNode} from '../../state';
import type {FileMessageBuilder} from '../../../types';
import {UsageAccumulator} from '../../../services/usage-accumulator.service';
import {
  modelLabel,
  resolveAiSdkModel,
  toModelRouterFallbackConfig,
} from '../../../runtime/model-resolver';
import {
  buildProviderOptions,
  resolveEnvTemperature,
} from '../../../components/db-query/_helpers';
import {sanitizeFilenameForAwsConverse} from '../../../sub-modules/providers/aws/utils';
import {ChatNodes} from '../nodes.enum';

const debug = debugFactory('ai-integration:chat:summarise-file.node');

/**
 * sourceloop/file-utils' @multipartRequestBody resolves a one-file upload to a
 * single Express.Multer.File; multi-file uploads land as an array. Normalise so
 * callers only deal with the array case.
 */
type MulterFileInput = Express.Multer.File[] | Express.Multer.File | undefined;

function normaliseFileList(files: MulterFileInput): Express.Multer.File[] {
  if (Array.isArray(files)) return files;
  return files ? [files] : [];
}

/**
 * No file model / chat model bound. Emit a Status per file so the UI knows
 * attachments were received but skipped, then return the un-augmented query
 * rather than crashing the run.
 */
function emitSkipsAndReturn(
  list: Express.Multer.File[],
  query: string,
  push: (e: LLMStreamEvent) => void,
): string {
  for (const file of list) {
    push({
      type: LLMStreamEventType.Status,
      data: `Skipped file ${file.originalname}: no LLM bound for summarisation`,
    });
  }
  return query;
}

/**
 * Summarise each attached file against the user's prompt and merge the
 * summaries into the query — the LangGraph `SummariseFileNode`. LangGraph
 * looped a graph edge back to itself per file; here one node handles the whole
 * list. Emits a Status per file (the SSE contract).
 *
 * A DI-resolved `@graphNode` class: the file/chat model configs, Mastra,
 * UsageAccumulator and the optional FileMessageBuilder are constructor-injected,
 * and the summarisation logic lives in `protected` methods so a host can
 * `extends SummariseFileNode` (override the prompt / file-part shape) or rebind
 * `@graphNode(ChatNodes.SummariseFile)` entirely.
 */
@graphNode(ChatNodes.SummariseFile)
export class SummariseFileNode implements IChatNode {
  constructor(
    @inject(AiIntegrationBindings.Mastra) protected readonly mastra: Mastra,
    @inject(AiIntegrationBindings.FileLLM, {optional: true})
    protected readonly fileLlm?: MastraModelConfig,
    @inject(AiIntegrationBindings.ChatLLM, {optional: true})
    protected readonly chatLlm?: MastraModelConfig,
    @inject('services.UsageAccumulator', {optional: true})
    protected readonly usage?: UsageAccumulator,
    @inject(AiIntegrationBindings.FileMessageBuilder, {optional: true})
    protected readonly fileMessageBuilder?: FileMessageBuilder,
  ) {}

  async execute(state: ChatState): Promise<Partial<ChatState>> {
    const augmentedQuery = await this.summariseAndMergeFiles(
      state.query,
      state.files,
      state.push,
    );
    return {augmentedQuery};
  }

  protected async summariseAndMergeFiles(
    query: string,
    files: MulterFileInput,
    push: (e: LLMStreamEvent) => void,
  ): Promise<string> {
    const list = normaliseFileList(files);
    if (!list.length) return query;
    const modelConfig = this.resolveFileSummaryModelConfig();
    if (!modelConfig) return emitSkipsAndReturn(list, query, push);
    const model = await this.resolveAiLanguageModel(modelConfig);
    if (!model) return emitSkipsAndReturn(list, query, push);
    const summaries: string[] = [];
    for (const file of list) {
      const summary = await this.summariseFile(query, file, model, push);
      if (summary) summaries.push(summary);
    }
    if (!summaries.length) return query;
    return `${query}\n\n${summaries.join('\n\n')}`;
  }

  protected async summariseFile(
    query: string,
    file: Express.Multer.File,
    model: Exclude<LanguageModel, string>,
    push: (e: LLMStreamEvent) => void,
  ): Promise<string | undefined> {
    push({
      type: LLMStreamEventType.Status,
      data: `Reading file: ${file.originalname}`,
    });
    const providerOptions = buildProviderOptions();
    const temperature = resolveEnvTemperature();
    try {
      const result = await generateText({
        model,
        ...(temperature === undefined ? {} : {temperature}),
        messages: [
          {
            role: 'system',
            content:
              'Summarise the attached file with the user prompt in mind. ' +
              'Keep important details that may answer the user query. ' +
              'Return plain text only — no markdown, no preamble.',
          },
          {
            role: 'user',
            content: [{type: 'text', text: query}, this.buildFileContent(file)],
          },
        ],
        ...(providerOptions ? {providerOptions: providerOptions as never} : {}),
      });
      // Count the file-summary call toward the request total (LangGraph's
      // TokenCounter hooked every LLM call; Mastra's stream.usage covers only
      // the chat turn).
      const fu = result.usage as
        | {inputTokens?: number; outputTokens?: number}
        | undefined;
      this.usage?.add(modelLabel(this.fileLlm ?? this.chatLlm), {
        inputTokens: fu?.inputTokens ?? 0,
        outputTokens: fu?.outputTokens ?? 0,
      });
      return `[Attached file "${file.originalname}"]\n${result.text.trim()}`;
    } catch (err) {
      debug('file summarisation failed for %s: %o', file.originalname, err);
      push({
        type: LLMStreamEventType.Status,
        data: `Failed to read file: ${file.originalname}`,
      });
      return undefined;
    }
  }

  /**
   * Build the file content part. Delegates to a consumer-bound
   * FileMessageBuilder when present (LangGraph `LLMProvider.getFile` — e.g. AWS
   * Bedrock `document` blocks), otherwise emits the generic AI-SDK `{type:'file'}`
   * part. The filename is sanitised so Bedrock Converse accepts the upload;
   * other providers ignore it.
   */
  protected buildFileContent(file: Express.Multer.File): {
    type: 'file';
    data: Buffer;
    mediaType: string;
    filename: string;
  } {
    if (this.fileMessageBuilder) {
      return this.fileMessageBuilder(file) as never;
    }
    return {
      type: 'file',
      data: file.buffer ?? Buffer.alloc(0),
      mediaType: file.mimetype || 'application/pdf',
      filename: sanitizeFilenameForAwsConverse(file.originalname),
    };
  }

  protected resolveFileSummaryModelConfig(): MastraModelConfig | undefined {
    // fileLlm FIRST — consumers bind a vision/file-capable model there
    // specifically for file summarisation. chatLlm is the fallback when no
    // dedicated file model is bound (LangGraph: SummariseFileNode used FileLLM
    // with a chat fallback).
    if (this.fileLlm) return this.fileLlm;
    if (this.chatLlm) return this.chatLlm;
    const defaultModel = process.env.MASTRA_DEFAULT_CHAT_MODEL;
    return defaultModel ? toModelRouterFallbackConfig(defaultModel) : undefined;
  }

  protected resolveAiLanguageModel(
    modelConfig: MastraModelConfig,
  ): Promise<Exclude<LanguageModel, string> | undefined> {
    return resolveAiSdkModel(this.mastra, modelConfig);
  }
}

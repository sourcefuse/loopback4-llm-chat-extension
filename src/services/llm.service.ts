/**
 * LLM interaction service.
 *
 * Replaces LangChain's `PromptTemplate` / `RunnableSequence` / `llm.invoke` /
 * `llm.bindTools` with thin, DI-managed wrappers over the Vercel AI SDK
 * (`generateText`). Messages are native AI SDK `ModelMessage` objects. Injected
 * wherever a node/service/visualizer needs to render a prompt or call a model,
 * so no LLM logic lives in free module functions.
 */
import {BindingScope, injectable} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {randomUUID} from 'node:crypto';
import {
  generateText,
  tool as aiTool,
  type AssistantContent,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import {Messages} from '../graphs/messages';
import {
  GraphTool,
  LLMCallbacks,
  LLMEndResult,
  RunnableConfig,
} from '../graphs/types';
import {LLMProvider} from '../types';

/** An AI SDK model augmented with the optional file builder + default settings. */
export type ConfiguredModel = LLMProvider;

/** Options for a single model call. */
export interface InvokeOptions {
  system?: string;
  tools?: GraphTool[];
  temperature?: number;
  config?: RunnableConfig;
}

@injectable({scope: BindingScope.SINGLETON})
export class LlmService {
  /**
   * Renders an f-string template with the exact `{var}` / `{{` / `}}` semantics
   * of `PromptTemplate.fromTemplate`, so rendered prompt text is byte-identical.
   * Single pass so escaped `{{`/`}}` (literal braces, e.g. JSON examples in a
   * prompt) are never mistaken for variables.
   */
  render(template: string, vars: Record<string, unknown> = {}): string {
    let result = '';
    let i = 0;
    while (i < template.length) {
      const pair = template.slice(i, i + 2);
      if (pair === '{{') {
        result += '{';
        i += 2;
      } else if (pair === '}}') {
        result += '}';
        i += 2;
      } else if (template[i] === '{') {
        const end = template.indexOf('}', i + 1);
        if (end === -1) {
          result += template[i];
          i += 1;
        } else {
          result += this.resolveVar(template.slice(i + 1, end).trim(), vars);
          i = end + 1;
        }
      } else {
        result += template[i];
        i += 1;
      }
    }
    return result;
  }

  /**
   * Calls the model once and returns the assistant `ModelMessage` (with any
   * tool-call parts). Fires the run's `handleLLMStart`/`handleLLMEnd` callbacks
   * so token accounting keeps working. Replaces `llm.invoke` /
   * `llm.bindTools(tools).invoke(...)`.
   */
  async invoke(
    model: ConfiguredModel,
    input: string | Messages,
    options: InvokeOptions = {},
  ): Promise<ModelMessage> {
    const all: ModelMessage[] =
      typeof input === 'string' ? [{role: 'user', content: input}] : input;
    const {system, messages} = this.hoistSystem(all, options.system);

    const runId = randomUUID();
    const modelName = this.getModelId(model);
    const callbacks = options.config?.callbacks ?? [];
    this.fireCallbacks(callbacks, cb =>
      cb.handleLLMStart?.(runId, modelName, {system, messages}),
    );

    const toolSet = options.tools?.length
      ? this.toToolSet(options.tools)
      : undefined;

    const result = await generateText({
      ...model.defaultSettings,
      model,
      ...(system ? {system} : {}),
      messages,
      ...(toolSet ? {tools: toolSet} : {}),
      ...(options.temperature !== undefined
        ? {temperature: options.temperature}
        : {}),
      abortSignal: options.config?.signal,
    });

    const content = this.toAssistantContent(result);
    const endResult = this.toEndResult(
      result.usage ?? {inputTokens: 0, outputTokens: 0},
    );
    this.fireCallbacks(callbacks, cb =>
      cb.handleLLMEnd?.(runId, endResult, {text: result.text, content}),
    );

    return {role: 'assistant', content};
  }

  /** A default file content block for a model that has no custom `getFile`. */
  defaultFileContent(file: Express.Multer.File): AnyObject {
    return {
      type: 'file',
      mediaType: 'application/pdf',
      data: file.buffer?.toString('base64') ?? '',
    };
  }

  /** Coerces a template variable to its rendered string (null/undefined → ''). */
  private stringifyVar(value: unknown): string {
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    // Objects/arrays/other — serialize rather than rely on default toString.
    return JSON.stringify(value) ?? '';
  }

  /** Resolves a `{key}` placeholder, throwing on an unknown variable. */
  private resolveVar(key: string, vars: Record<string, unknown>): string {
    if (!(key in vars)) {
      throw new Error(`Missing value for input variable "${key}"`);
    }
    return this.stringifyVar(vars[key]);
  }

  /** Builds the AI SDK tool set (no `execute`, so the graph runs the tool loop). */
  private toToolSet(tools: GraphTool[]): ToolSet {
    const set: ToolSet = {};
    for (const t of tools) {
      set[t.name] = aiTool({
        description: t.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: t.schema as any,
      });
    }
    return set;
  }

  private getModelId(model: LanguageModel): string {
    if (typeof model === 'string') {
      return model;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (model as any).modelId ?? 'unknown';
  }

  /**
   * Hoists system-role content into a single `system` string (the AI SDK expects
   * system content out of `messages`), returning the remaining non-system turns.
   */
  private hoistSystem(
    all: ModelMessage[],
    optionSystem?: string,
  ): {system?: string; messages: ModelMessage[]} {
    const systemParts: string[] = [];
    const messages: ModelMessage[] = [];
    for (const message of all) {
      if (message.role === 'system') {
        systemParts.push(
          typeof message.content === 'string' ? message.content : '',
        );
      } else {
        messages.push(message);
      }
    }
    if (optionSystem) {
      systemParts.unshift(optionSystem);
    }
    return {
      system: systemParts.filter(Boolean).join('\n\n') || undefined,
      messages,
    };
  }

  /** Builds the `LLMEndResult` shape the token-counter / Langfuse callbacks expect. */
  private toEndResult(usage: {
    inputTokens?: number;
    outputTokens?: number;
  }): LLMEndResult {
    return {
      generations: [
        [
          {
            message: {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              usage_metadata: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                input_tokens: usage.inputTokens ?? 0,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                output_tokens: usage.outputTokens ?? 0,
              },
            },
          },
        ],
      ],
    };
  }

  /** Converts an AI SDK generate result into an assistant message content value. */
  private toAssistantContent(result: {
    text?: string;
    toolCalls?: Array<{toolCallId: string; toolName: string; input: unknown}>;
  }): AssistantContent {
    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return result.text ?? '';
    }
    return [
      ...(result.text ? [{type: 'text' as const, text: result.text}] : []),
      ...toolCalls.map(tc => ({
        type: 'tool-call' as const,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      })),
    ];
  }

  private fireCallbacks(
    callbacks: LLMCallbacks[],
    fn: (cb: LLMCallbacks) => void,
  ): void {
    for (const cb of callbacks) {
      fn(cb);
    }
  }
}

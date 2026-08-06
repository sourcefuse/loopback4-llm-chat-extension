/**
 * Internal LLM helper.
 *
 * Replaces LangChain's `PromptTemplate` / `RunnableSequence` / `llm.invoke` /
 * `llm.bindTools` with thin wrappers over the Vercel AI SDK (`generateText`,
 * `embed`, `embedMany`). Messages are native AI SDK `ModelMessage` objects.
 */
import {randomUUID} from 'crypto';
import {
  embed,
  embedMany,
  generateText,
  tool as aiTool,
  type AssistantContent,
  type EmbeddingModel,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import {AnyObject} from '@loopback/repository';
import {LLMProvider} from '../types';
import {Messages} from './messages';
import {GraphTool, LLMEndResult, RunnableConfig} from './types';

/** An AI SDK model augmented with the optional file builder + default settings. */
export type ConfiguredModel = LLMProvider;

/**
 * Renders an f-string template with the exact `{var}` / `{{` / `}}` semantics of
 * `PromptTemplate.fromTemplate`, so rendered prompt text is byte-identical.
 * Single pass so escaped `{{`/`}}` (literal braces, e.g. JSON examples in a
 * prompt) are never mistaken for variables.
 */
export function renderPrompt(
  template: string,
  vars: Record<string, unknown> = {},
): string {
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
        continue;
      }
      const key = template.slice(i + 1, end).trim();
      if (!(key in vars)) {
        throw new Error(`Missing value for input variable "${key}"`);
      }
      const value = vars[key];
      result += value === undefined || value === null ? '' : String(value);
      i = end + 1;
    } else {
      result += template[i];
      i += 1;
    }
  }
  return result;
}

function toToolSet(tools: GraphTool[]): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    // No `execute`: the model returns the tool call without running it, so the
    // graph keeps control of the tool loop (matching the old bindTools flow).
    set[t.name] = aiTool({
      description: t.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: t.schema as any,
    });
  }
  return set;
}

export interface InvokeOptions {
  system?: string;
  tools?: GraphTool[];
  temperature?: number;
  config?: RunnableConfig;
}

function getModelId(model: LanguageModel): string {
  if (typeof model === 'string') {
    return model;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (model as any).modelId ?? 'unknown';
}

/**
 * Builds the AI SDK `experimental_telemetry` option so each model call emits
 * standard OpenTelemetry gen-ai spans. These are backend-agnostic: any exporter
 * the host registers on the global OTEL tracer consumes them — Langfuse
 * (`@langfuse/otel`), LangSmith (its OTLP endpoint), or a generic OTLP
 * collector. Gated by env so there's no overhead (and no PII in spans) when
 * tracing is disabled; when no tracer is registered the AI SDK falls back to a
 * no-op tracer, so this is always safe to pass.
 */
function buildTelemetry(
  config: RunnableConfig | undefined,
  modelName: string,
):
  | {
      isEnabled: true;
      functionId: string;
      metadata: Record<string, string>;
    }
  | undefined {
  const enabled =
    process.env.AI_SDK_TELEMETRY === '1' ||
    process.env.LANGSMITH_TRACING === 'true' ||
    !!+(process.env.ENABLE_TRACING ?? 0);
  if (!enabled) {
    return undefined;
  }
  const functionId =
    (config?.configurable?.functionId as string | undefined) ?? 'invokeModel';
  return {
    isEnabled: true,
    functionId,
    metadata: {
      model: modelName,
      ...(process.env.LANGSMITH_PROJECT
        ? {'langsmith.metadata.project': process.env.LANGSMITH_PROJECT}
        : {}),
    },
  };
}

/**
 * Calls the model once and returns the assistant `ModelMessage` (with any
 * tool-call parts). Fires the run's `handleLLMStart`/`handleLLMEnd` callbacks so
 * token accounting keeps working. Replaces `llm.invoke` /
 * `llm.bindTools(tools).invoke(...)`.
 */
export async function invokeModel(
  model: ConfiguredModel,
  input: string | Messages,
  options: InvokeOptions = {},
): Promise<ModelMessage> {
  const settings = model.defaultSettings ?? {};
  const all: ModelMessage[] =
    typeof input === 'string' ? [{role: 'user', content: input}] : input;

  // The AI SDK rejects system-role entries inside `messages` ("System messages
  // are not allowed... use the instructions option instead"), so hoist any
  // system content (from a system message in the list or the `system` option)
  // into the top-level `system` parameter and keep only non-system turns.
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
  if (options.system) {
    systemParts.unshift(options.system);
  }
  const system = systemParts.filter(Boolean).join('\n\n') || undefined;

  const runId = randomUUID();
  const modelName = getModelId(model);
  const callbacks = options.config?.callbacks ?? [];
  for (const cb of callbacks) {
    cb.handleLLMStart?.(runId, modelName);
  }

  const toolSet =
    options.tools && options.tools.length > 0
      ? toToolSet(options.tools)
      : undefined;

  const telemetry = buildTelemetry(options.config, modelName);

  const result = await generateText({
    ...settings,
    model,
    ...(system ? {system} : {}),
    messages,
    ...(toolSet ? {tools: toolSet} : {}),
    ...(options.temperature !== undefined
      ? {temperature: options.temperature}
      : {}),
    abortSignal: options.config?.signal,
    ...(telemetry
      ? // eslint-disable-next-line @typescript-eslint/naming-convention
        {experimental_telemetry: telemetry}
      : {}),
  });

  const usage = result.usage ?? {inputTokens: 0, outputTokens: 0};
  const endResult: LLMEndResult = {
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
  for (const cb of callbacks) {
    cb.handleLLMEnd?.(runId, endResult);
  }

  const toolCalls = result.toolCalls ?? [];
  const content: AssistantContent = toolCalls.length
    ? [
        ...(result.text ? [{type: 'text' as const, text: result.text}] : []),
        ...toolCalls.map(tc => ({
          type: 'tool-call' as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })),
      ]
    : (result.text ?? '');

  return {role: 'assistant', content};
}

/** Embeds a single string. Replaces LangChain embeddings `.embedQuery`. */
export async function embedText(
  model: EmbeddingModel,
  value: string,
): Promise<number[]> {
  const {embedding} = await embed({model, value});
  return embedding as number[];
}

/** Embeds many strings. Replaces LangChain embeddings `.embedDocuments`. */
export async function embedTexts(
  model: EmbeddingModel,
  values: string[],
): Promise<number[][]> {
  const {embeddings} = await embedMany({model, values});
  return embeddings as number[][];
}

/** A default file content block for a model that has no custom `getFile`. */
export function defaultFileContent(file: Express.Multer.File): AnyObject {
  return {
    type: 'file',
    mediaType: 'application/pdf',
    data: file.buffer?.toString('base64') ?? '',
  };
}

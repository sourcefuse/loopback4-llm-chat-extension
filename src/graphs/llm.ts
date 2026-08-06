/**
 * Internal LLM helper.
 *
 * Replaces LangChain's `PromptTemplate` / `RunnableSequence` / `llm.invoke` /
 * `llm.bindTools` with thin wrappers over the Vercel AI SDK (`generateText`,
 * `embed`, `embedMany`). Messages are native AI SDK `ModelMessage` objects.
 */
import {randomUUID} from 'node:crypto';
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
import {GraphTool, LLMCallbacks, LLMEndResult, RunnableConfig} from './types';

/** An AI SDK model augmented with the optional file builder + default settings. */
export type ConfiguredModel = LLMProvider;

/** Coerces a template variable to its rendered string (null/undefined → ''). */
function stringifyVar(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  // Primitive (string/number/boolean/bigint) — safe to String()-coerce.
  return String(value);
}

/** Resolves a `{key}` placeholder, throwing on an unknown variable. */
function resolveVar(key: string, vars: Record<string, unknown>): string {
  if (!(key in vars)) {
    throw new Error(`Missing value for input variable "${key}"`);
  }
  return stringifyVar(vars[key]);
}

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
      } else {
        result += resolveVar(template.slice(i + 1, end).trim(), vars);
        i = end + 1;
      }
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
 * Hoists system-role content into a single `system` string (the AI SDK expects
 * system content out of `messages`), returning the remaining non-system turns.
 */
function hoistSystem(
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
function toEndResult(usage: {
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
function toAssistantContent(result: {
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

function fireCallbacks(
  callbacks: LLMCallbacks[],
  fn: (cb: LLMCallbacks) => void,
): void {
  for (const cb of callbacks) {
    fn(cb);
  }
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
  const all: ModelMessage[] =
    typeof input === 'string' ? [{role: 'user', content: input}] : input;
  const {system, messages} = hoistSystem(all, options.system);

  const runId = randomUUID();
  const modelName = getModelId(model);
  const callbacks = options.config?.callbacks ?? [];
  fireCallbacks(callbacks, cb => cb.handleLLMStart?.(runId, modelName));

  const toolSet = options.tools?.length ? toToolSet(options.tools) : undefined;
  const telemetry = buildTelemetry(options.config, modelName);

  const result = await generateText({
    ...(model.defaultSettings ?? {}),
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

  const endResult = toEndResult(
    result.usage ?? {inputTokens: 0, outputTokens: 0},
  );
  fireCallbacks(callbacks, cb => cb.handleLLMEnd?.(runId, endResult));

  return {role: 'assistant', content: toAssistantContent(result)};
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

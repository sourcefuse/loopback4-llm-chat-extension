import {generateObject, generateText} from 'ai';
import type {MastraLanguageModel} from '@mastra/core/agent';
import type {RequestContext} from '@mastra/core/request-context';

type TelemetryPrimitive = string | number | boolean;

type InvokeLlmOptions = {
  requestContext?: RequestContext;
  functionId?: string;
  metadata?: Record<string, TelemetryPrimitive>;
  abortSignal?: AbortSignal;
};

type AiModel = Parameters<typeof generateText>[0]['model'];

function isTelemetryPrimitive(value: unknown): value is TelemetryPrimitive {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function resolveAbortSignal(
  options: InvokeLlmOptions,
): AbortSignal | undefined {
  if (options.abortSignal) {
    return options.abortSignal;
  }
  const signalFromContext = options.requestContext?.get('abortSignal');
  return signalFromContext instanceof AbortSignal
    ? signalFromContext
    : undefined;
}

function resolveUserId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const userId = (value as {id?: unknown}).id;
  if (typeof userId === 'string' || typeof userId === 'number') {
    return String(userId);
  }

  return undefined;
}

function buildTelemetryMetadata(
  options: InvokeLlmOptions,
): Record<string, TelemetryPrimitive> {
  const metadata: Record<string, TelemetryPrimitive> = {};
  const requestContext = options.requestContext;

  const correlationId = requestContext?.get('correlationId');
  if (typeof correlationId === 'string' && correlationId.length > 0) {
    metadata.correlationId = correlationId;
  }

  const workflowId = requestContext?.get('workflowId');
  if (typeof workflowId === 'string' && workflowId.length > 0) {
    metadata.workflowId = workflowId;
  }

  const chatSessionId = requestContext?.get('chatSessionId');
  if (typeof chatSessionId === 'string' && chatSessionId.length > 0) {
    metadata.chatSessionId = chatSessionId;
  }

  const userId = resolveUserId(requestContext?.get('currentUser'));
  if (userId) {
    metadata.userId = userId;
  }

  const contextMetadata = requestContext?.get('aiSdkTelemetryMetadata');
  if (contextMetadata && typeof contextMetadata === 'object') {
    for (const [key, value] of Object.entries(
      contextMetadata as Record<string, unknown>,
    )) {
      if (isTelemetryPrimitive(value)) {
        metadata[key] = value;
      }
    }
  }

  if (options.metadata) {
    for (const [key, value] of Object.entries(options.metadata)) {
      metadata[key] = value;
    }
  }

  return metadata;
}

function buildTelemetryConfig(options: InvokeLlmOptions) {
  const enabledFromContext = options.requestContext?.get(
    'aiSdkTelemetryEnabled',
  );
  const isEnabled =
    typeof enabledFromContext === 'boolean' ? enabledFromContext : true;

  return {
    isEnabled,
    functionId: options.functionId ?? 'ai-integration.llm.invoke',
    metadata: buildTelemetryMetadata(options),
  };
}

/**
 * Invoke an LLM with a prompt string and return the text response.
 * Uses AI SDK generateText() with optional request-scoped telemetry metadata.
 *
 * @param llm - Mastra language model
 * @param prompt - Formatted prompt string
 * @returns Raw text response from the LLM
 */
export async function invokeLlm(
  llm: MastraLanguageModel,
  prompt: string,
  options: InvokeLlmOptions = {},
): Promise<string> {
  const requestOptions: Record<string, unknown> = {
    model: llm as unknown as AiModel,
    prompt,
    abortSignal: resolveAbortSignal(options),
  };
  requestOptions['experimental_telemetry'] = buildTelemetryConfig(options);

  const result = await generateText(
    requestOptions as Parameters<typeof generateText>[0],
  );

  return result.text;
}

/**
 * Invoke an LLM and enforce structured JSON output against the provided schema.
 */
export async function invokeLlmObject<TOutput extends object>(
  llm: MastraLanguageModel,
  prompt: string,
  schema: unknown,
  options: InvokeLlmOptions = {},
): Promise<TOutput> {
  const requestOptions: Record<string, unknown> = {
    model: llm as unknown as AiModel,
    prompt,
    output: 'object',
    schema: schema as never,
    abortSignal: resolveAbortSignal(options),
  };
  requestOptions['experimental_telemetry'] = buildTelemetryConfig(options);

  const result = await generateObject(
    requestOptions as Parameters<typeof generateObject>[0],
  );

  return result.object as TOutput;
}

/**
 * Strip `<think>...</think>` or `<thinking>...</thinking>` tags from LLM output.
 * Handles incomplete opening tags at the start of the response.
 */
export function stripThinkingTokens(text: string): string {
  let cleaned = text.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/g, '');
  // Handle case where response starts mid-thinking block (no opening tag)
  cleaned = cleaned.replace(/^[\s\S]*?<\/think(ing)?>/g, '');
  return cleaned.trim();
}

/**
 * Strip markdown code block fences from SQL output.
 */
export function stripCodeBlock(text: string): string {
  return text
    .replace(/^```(?:sql)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

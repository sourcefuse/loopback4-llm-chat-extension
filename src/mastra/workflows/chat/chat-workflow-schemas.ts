import {z} from 'zod';
import type {JsonValue} from '../../../types';

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

/**
 * Input schema for the ChatWorkflow.
 * Matches the existing ChatGraph.execute() signature.
 */
export const ChatWorkflowInputSchema = z.object({
  prompt: z.string().describe('The user prompt or message'),
  files: z
    .array(
      z
        .object({
          originalname: z.string(),
          buffer: z.instanceof(Buffer).optional(),
          mimetype: z.string().optional(),
          size: z.number().optional(),
          fieldname: z.string().optional(),
          encoding: z.string().optional(),
          // Allow arbitrary additional fields from Multer
        })
        .passthrough(),
    )
    .default([])
    .describe('Uploaded files to process'),
  sessionId: z
    .string()
    .optional()
    .describe('Existing chat session ID for resuming a conversation'),
});

export type ChatWorkflowInput = z.infer<typeof ChatWorkflowInputSchema>;

/**
 * Output schema for the ChatWorkflow.
 * Events are streamed via the AsyncEventQueue — not accumulated in output.
 */
export const ChatWorkflowOutputSchema = z.object({
  sessionId: z.string().describe('The chat session ID (new or existing)'),
});

export type ChatWorkflowOutput = z.infer<typeof ChatWorkflowOutputSchema>;

// ── Step-level schemas ────────────────────────────────────────────────────────

/**
 * InitSessionStep output
 */
export const InitSessionOutputSchema = z.object({
  sessionId: z.string(),
  isNewSession: z.boolean(),
  userMessageId: z.string().optional(),
  prompt: z.string(),
  files: z.array(z.object({}).passthrough()).default([]),
});
export type InitSessionOutput = z.infer<typeof InitSessionOutputSchema>;

/**
 * PrepareContextStep output
 */
export const PrepareContextOutputSchema = z.object({
  sessionId: z.string(),
  messages: z
    .array(
      z
        .object({
          role: z.string(),
          content: z.union([z.string(), z.array(z.object({}).passthrough())]),
        })
        .passthrough(),
    )
    .describe('Full conversation context (CoreMessage[])'),
  userMessageId: z.string().optional(),
  prompt: z.string(),
  files: z.array(z.object({}).passthrough()).default([]),
});
export type PrepareContextOutput = z.infer<typeof PrepareContextOutputSchema>;

/**
 * FileProcessingStep output
 */
export const FileProcessingOutputSchema = z.object({
  sessionId: z.string(),
  messages: z
    .array(
      z
        .object({
          role: z.string(),
          content: z.union([z.string(), z.array(z.object({}).passthrough())]),
        })
        .passthrough(),
    )
    .describe('Updated context after file processing'),
  userMessageId: z.string().optional(),
  prompt: z.string(),
});
export type FileProcessingOutput = z.infer<typeof FileProcessingOutputSchema>;

/**
 * AgentReasoningStep output
 */
export const AgentReasoningOutputSchema = z.object({
  sessionId: z.string(),
  finalText: z.string().describe('Final text response from the agent'),
  toolCalls: z
    .array(
      z.object({
        toolCallId: z.string(),
        toolName: z.string(),
        args: z.record(JsonValueSchema),
        rawResult: JsonValueSchema,
      }),
    )
    .default([]),
  totalInputTokens: z.number().default(0),
  totalOutputTokens: z.number().default(0),
  tokenMap: z
    .record(
      z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
      }),
    )
    .default({}),
  userMessageId: z.string().optional(),
});
export type AgentReasoningOutput = z.infer<typeof AgentReasoningOutputSchema>;

/**
 * PersistConversationStep output
 */
export const PersistConversationOutputSchema = z.object({
  sessionId: z.string(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  tokenMap: z.record(
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
  ),
});
export type PersistConversationOutput = z.infer<
  typeof PersistConversationOutputSchema
>;

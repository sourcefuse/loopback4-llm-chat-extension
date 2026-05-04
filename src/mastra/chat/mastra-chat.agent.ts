import {inject, injectable, BindingScope, service} from '@loopback/core';
import {streamText, tool, ToolSet, stepCountIs} from 'ai';
import {LLMStreamEvent, LLMStreamEventType} from '../../types/events';
import {ChatStore} from '../../services/chat.store';
import {AiIntegrationBindings} from '../../keys';
import {AIIntegrationConfig, LLMProvider, ToolStore} from '../../types';
import {MastraAgentMessage} from '../types';
import {IRuntimeTool} from '../../types/tool';
import {z} from 'zod';
import {normalizeMessages} from './utils/normalize-messages.util';
import {adaptStreamResult} from './utils/adapt-stream.util';
import {mastraRequestWriterStore} from '../request-tool-store';
import {compressContextIfNeeded} from './steps/context-compression.step';
import {initSession} from './steps/init-session.step';
import {summariseOneFile} from './steps/summarise-file.step';
import {handleStream} from './steps/stream-handler.step';
import {accumulateUsage} from './utils/token-accumulator.util';
import {TokenAccumulator} from './types/chat.types';

const debug = require('debug')('ai-integration:mastra:chat-agent');

/**
 * Mastra-runtime chat execution service.
 *
 * Orchestrates the full chat pipeline by delegating to focused step modules:
 *
 *  1. `initSession`            — load/create chat, persist human message, build history
 *  2. `summariseOneFile`*      — pre-process uploaded files before the agent sees them
 *  3. `compressContextIfNeeded`— trim history if it exceeds the token budget
 *  4. `streamText` execution   — library calls AI SDK directly, owns the LLM ↔ tool loop
 *  5. `handleStream`           — adapt AI SDK events → LLMStreamEvent, persist steps
 *  6. EndSession               — emit TokenCount, update DB
 */
@injectable({scope: BindingScope.REQUEST})
export class MastraChatAgent {
  constructor(
    @inject(AiIntegrationBindings.AiSdkChatLLM)
    private readonly chatLLM: LLMProvider,
    @inject(AiIntegrationBindings.AiSdkFileLLM)
    private readonly fileLLM: LLMProvider,
    @inject(AiIntegrationBindings.Config)
    private readonly aiConfig: AIIntegrationConfig,
    @inject(AiIntegrationBindings.Tools)
    private readonly tools: ToolStore,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    private readonly systemContext: string[] | undefined,
    @service(ChatStore)
    private readonly chatStore: ChatStore,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Runs the full Mastra chat pipeline and yields `LLMStreamEvent` values
   * that are 100 % compatible with the existing SSE transport.
   */
  async *execute(
    prompt: string,
    files: Express.Multer.File[] | undefined,
    abort: AbortSignal,
    id?: string,
  ): AsyncGenerator<LLMStreamEvent> {
    files = files ?? [];
    // ── Step 1: InitSession ──────────────────────────────────────────────────
    const {chatId, baseMessages, userMessage} = await initSession(
      prompt,
      id,
      this.chatStore,
      this._buildSystemPrompt(),
    );
    if (!id) {
      yield {type: LLMStreamEventType.Init, data: {sessionId: chatId}};
    }

    // ── Step 2: SummariseFile (pre-processing — outside the agent) ───────────
    let finalPrompt = prompt;
    const tokens: TokenAccumulator = {input: 0, output: 0, map: {}};

    for (const file of files) {
      yield {
        type: LLMStreamEventType.Log,
        data: `Processing file: ${file.originalname}`,
      };
      yield {
        type: LLMStreamEventType.Status,
        data: `Reading file: ${file.originalname}`,
      };
      finalPrompt = await summariseOneFile({
        file,
        currentPrompt: finalPrompt,
        chatId,
        userMessage,
        tokens,
        fileLLM: this.fileLLM,
        chatStore: this.chatStore,
      });
    }

    // ── Step 3: Build message list + fallback context compression ────────────
    const rawMessages: MastraAgentMessage[] = [
      ...baseMessages,
      {role: 'user', content: finalPrompt},
    ];
    const compressedMessages = await compressContextIfNeeded(
      rawMessages,
      this.aiConfig.maxTokenCount,
    );

    // ── Step 4: Build per-request tool map ──────────────────────────────────
    const requestToolMap = new Map<string, IRuntimeTool>();
    for (const graphTool of this.tools.list) {
      try {
        // Build tools at request time (they may have request-scoped dependencies).
        const rt = graphTool.createTool
          ? await graphTool.createTool({})
          : graphTool.build
            ? await graphTool.build({})
            : null;
        if (rt) {
          // Wrap invoke to inject the lazy writer into the LangGraph config so
          // internal graph nodes (e.g. RenderVisualizationNode, SaveDatasetNode)
          // get config.writer and their ToolStatus events reach the SSE stream.
          // Tools built with createTool() ignore the config param, but the
          // tool.invoke(input, { writer }) passes it straight to every node.
          const lazyWriter = {
            writer: (event: unknown) =>
              mastraRequestWriterStore.get(chatId)?.(event as LLMStreamEvent),
          };
          const wrappedRt: IRuntimeTool = {
            name: rt.name,
            description: rt.description,
            schema: rt.schema,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            invoke: (input: unknown) => (rt as any).invoke(input, lazyWriter),
          };

          // Keyed by graphTool.key (e.g. 'get-data-as-dataset').
          // This is the name the LLM will use when calling the tool, and what
          // handleStream uses to look up display values.
          requestToolMap.set(graphTool.key, wrappedRt);
        }
      } catch (err) {
        debug(
          'Could not build tool %s for request registry: %o',
          graphTool.key,
          err,
        );
      }
    }
    debug(
      'Built %d tools for chatId %s: %s',
      requestToolMap.size,
      chatId,
      [...requestToolMap.keys()].join(', '),
    );

    // ── Step 5: Build AI SDK tool set and call streamText() directly ──────────
    const aiTools: ToolSet = {};
    for (const [toolName, rt] of requestToolMap) {
      if (aiTools[toolName]) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inputSchema: z.ZodTypeAny = (rt.schema as any) ?? z.object({});
      aiTools[toolName] = tool({
        description: rt.description ?? toolName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: inputSchema as any,
        execute: async (input: unknown) => {
          try {
            return await rt.invoke(input);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            debug('Tool "%s" failed: %s', toolName, msg);
            return {error: true, message: msg};
          }
        },
      });
    }

    debug(
      'Calling streamText() directly — %d messages, %d tools',
      compressedMessages.length,
      Object.keys(aiTools).length,
    );
    try {
      const streamResult = streamText({
        model: this.chatLLM,
        messages: normalizeMessages(compressedMessages),
        tools: aiTools,
        stopWhen: stepCountIs(10),
        abortSignal: abort,
      });
      const agentStream = adaptStreamResult(streamResult);

      for await (const event of handleStream({
        agentStream,
        abort,
        tools: this.tools,
        chatId,
        chatStore: this.chatStore,
        tokens,
      })) {
        yield event;
      }

      // Fallback: use stream-level usage promise when no per-step usage arrived
      if (tokens.input === 0 && tokens.output === 0) {
        try {
          const streamUsage = await agentStream.usage;
          if (streamUsage) {
            // Mastra LanguageModelUsage uses inputTokens/outputTokens
            accumulateUsage(
              {
                promptTokens: (streamUsage as unknown as {inputTokens?: number})
                  .inputTokens,
                completionTokens: (
                  streamUsage as unknown as {outputTokens?: number}
                ).outputTokens,
              },
              'mastra-chat',
              tokens,
            );
          }
        } catch {
          // usage not available — proceed without it
        }
      }

      // ── Step 7: EndSession ─────────────────────────────────────────────────
      yield {
        type: LLMStreamEventType.TokenCount,
        data: {inputTokens: tokens.input, outputTokens: tokens.output},
      };
      await this.chatStore.updateCounts(
        chatId,
        tokens.input,
        tokens.output,
        tokens.map,
      );
    } finally {
      // Clean up the per-request writer store so memory doesn't leak.
      mastraRequestWriterStore.delete(chatId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers (instance-state dependent — kept in agent)
  // ---------------------------------------------------------------------------

  private _buildSystemPrompt(): string {
    return [
      `You are a helpful AI assistant. You MUST always use one of the available tools to handle the user's request. Never respond with just text on the first message — always call the closest matching tool, even if you are unsure. The tool will reject the request if it is not suitable.`,
      `If you are not sure about the result, you can ask the user to review the result and provide feedback.`,
      `Only use a single tool in a single message, but you can use multiple tools over subsequent messages if it could help with the user's requirements.`,
      `If the user provides feedback, you can use that feedback to improve the result.`,
      `Do not write any redundant messages before or after tool calls, be as concise as possible.`,
      `Do not hallucinate details or make up information.`,
      `Do not make assumptions about user's intent beyond what is explicitly provided in the prompt, and keep this in mind while calling tools.`,
      `Do not use technical jargon in the response, show any internal IDs, or implementation details to the user.`,
      `Current date is ${new Date().toDateString()}`,
      ...(this.systemContext ?? []),
    ].join('\n');
  }
}

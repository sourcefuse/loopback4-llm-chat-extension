import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {LLMStreamEventType} from '../../../../graphs/event.types';
import {
  chatReasoningAgent,
  emitToolStatusEvent,
} from '../../../agents/chat-reasoning.agent';
import {asWorkflowContext} from '../../../bridge/workflow-request-context';
import {
  FileProcessingOutputSchema,
  AgentReasoningOutputSchema,
} from '../chat-workflow-schemas';
import type {AnyObject} from '@loopback/repository';

const debug = require('debug')('ai-integration:mastra:agent-reasoning.step');

/**
 * AgentReasoningStep — the core agentic loop.
 *
 * LangGraph equivalent: `CallLLMNode` + `RunToolNode` + the graph loop edge.
 *
 * Event architecture (per TDD):
 *  - Tool / ToolStatus events → AsyncEventQueue (agent callbacks cannot use writer)
 *  - Message event → writer.write() AFTER agent completes (workflow-native streaming)
 *  - Token accumulation → step-finish chunks in fullStream (V2 naming: inputTokens/outputTokens)
 *
 * Stream chunk typing:
 *  Mastra's AgentChunkType is a discriminated union — we use switch/case narrowing.
 *  No unsafe casts. Each branch has fully typed payload access.
 */
export const agentReasoningStep = createStep({
  id: 'agent-reasoning',
  description:
    'Run the ChatReasoningAgent in a multi-step tool-calling loop; stream events to the client',
  inputSchema: FileProcessingOutputSchema,
  outputSchema: AgentReasoningOutputSchema,
  execute: async ({inputData, requestContext, writer}) => {
    const ctx = asWorkflowContext(requestContext);

    const {sessionId, messages, userMessageId} = inputData;

    const eventQueue = ctx.get('eventQueue');
    const tokenAccumulator = ctx.get('tokenUsageAccumulator');
    const toolStore = ctx.get('toolStore');
    const abortSignal = ctx.get('abortSignal');
    const aiConfig = ctx.get('aiConfig') as
      | {maxSteps?: number; modelName?: string}
      | undefined;

    debug(
      `AgentReasoning: streaming agent with ${messages.length} messages, session=${sessionId}`,
    );

    const toolCallRecords: z.infer<
      typeof AgentReasoningOutputSchema
    >['toolCalls'] = [];

    let finalText = '';

    const agentOutput = await chatReasoningAgent.stream(
      messages as Parameters<typeof chatReasoningAgent.stream>[0],
      {
        maxSteps: (aiConfig as {maxSteps?: number} | undefined)?.maxSteps ?? 20,
        abortSignal,
        requestContext: ctx,
      },
    );

    // Consume the full stream using discriminated union narrowing.
    // AgentChunkType is: tool-call | tool-result | text-delta | step-finish | error | ...
    // Each case uses the narrowed payload type — no unsafe casts.
    for await (const chunk of agentOutput.fullStream) {
      if (abortSignal?.aborted) {
        debug('AgentReasoning: abort signal received, stopping stream');
        break;
      }

      switch (chunk.type) {
        case 'tool-call': {
          // chunk.payload is ToolCallPayload (typed via discriminated union)
          const {toolCallId, toolName, args} = chunk.payload;
          debug(`AgentReasoning: tool call → ${toolName}`);
          eventQueue.push({
            type: LLMStreamEventType.Tool,
            data: {
              id: toolCallId,
              tool: toolName,
              data: (args ?? {}) as AnyObject,
            },
          });
          break;
        }

        case 'tool-result': {
          // chunk.payload is ToolResultPayload (typed via discriminated union)
          const {toolCallId, toolName, args, result} = chunk.payload;
          debug(`AgentReasoning: tool result → ${toolName}`);

          toolCallRecords.push({
            toolCallId,
            toolName,
            args: (args ?? {}) as AnyObject,
            rawResult: (result ?? {}) as AnyObject,
          });

          // IGraphTool sub-graphs emit ToolStatus internally via config.writer → eventQueue.
          // For plain Mastra tools (not IGraphTool), emit a generic ToolStatus here.
          const igraphTool = toolStore?.map?.[toolName];
          if (!igraphTool) {
            emitToolStatusEvent(
              eventQueue,
              toolCallId,
              toolStore,
              toolName,
              (result ?? {}) as AnyObject,
            );
          }
          break;
        }

        case 'text-delta': {
          // chunk.payload is TextDeltaPayload (typed via discriminated union)
          // Accumulate text — emit ONE Message event after agent completes (TDD §6A.6)
          finalText += chunk.payload.text;
          break;
        }

        case 'step-finish': {
          // chunk.payload is StepFinishPayload — typed, no cast needed
          // LanguageModelUsage uses V2 naming: inputTokens / outputTokens
          const usage = chunk.payload.output?.usage;
          if (usage) {
            const modelId =
              (aiConfig as {modelName?: string} | undefined)?.modelName ??
              'chat-llm';
            tokenAccumulator?.accumulate(
              modelId,
              usage.inputTokens ?? 0,
              usage.outputTokens ?? 0,
            );
          }
          break;
        }

        case 'error': {
          // chunk.payload is ErrorPayload (typed via discriminated union)
          const errMsg =
            chunk.payload.error instanceof Error
              ? chunk.payload.error.message
              : 'Agent stream error';
          debug('AgentReasoning: stream error chunk:', errMsg);
          eventQueue.push({
            type: LLMStreamEventType.Error,
            data: {message: errMsg},
          });
          break;
        }

        default:
          // All other chunk types (reasoning-delta, file, source, etc.) are ignored.
          break;
      }
    }

    // After agent completes: emit the full Message event via writer (workflow-native streaming).
    // This ensures Message arrives through the workflow stream, not the AsyncEventQueue.
    // ⚠️ MUST be awaited — writer is a WritableStream; concurrent writes cause errors.
    if (finalText) {
      await writer.write({
        type: LLMStreamEventType.Message,
        data: {message: finalText},
      });
    }

    // Close the AsyncEventQueue — signals WorkflowRunner that no more agent callbacks will arrive.
    // WorkflowRunner's concurrent queue drainer will complete after all enqueued events are forwarded.
    eventQueue.close();

    const counts = tokenAccumulator?.getCounts() ?? {
      inputs: 0,
      outputs: 0,
      map: {},
    };

    debug(
      `AgentReasoning: done. finalTextLength=${finalText.length}, toolCalls=${toolCallRecords.length}`,
    );

    return {
      sessionId,
      finalText,
      toolCalls: toolCallRecords,
      totalInputTokens: counts.inputs,
      totalOutputTokens: counts.outputs,
      tokenMap: counts.map as z.infer<
        typeof AgentReasoningOutputSchema
      >['tokenMap'],
      userMessageId,
    };
  },
});

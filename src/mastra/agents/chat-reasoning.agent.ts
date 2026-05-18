import {Agent} from '@mastra/core/agent';
import {RequestContext} from '@mastra/core/request-context';
import type {MastraLanguageModel} from '@mastra/core/agent';
import type {MastraModelConfig} from '@mastra/core/llm';
import {LLMStreamEventType} from '../../graphs/event.types';
import type {AsyncEventQueue} from '../bridge/async-event-queue';
import type {JsonObject, MastraToolStore} from '../../types';
import {asWorkflowContext} from '../bridge/workflow-request-context';

/**
 * ChatReasoningAgent — the Mastra Agent that drives the multi-turn tool-calling loop.
 *
 * Replaces the CallLLM → RunTool → TrimMessages cycle in the original ChatGraph.
 * The model and tools are resolved dynamically from RequestContext at runtime.
 *
 * Architecture:
 *  - model: resolved from RequestContext at each call (supports per-request model injection)
 *  - tools: resolved from the MastraToolStore in RequestContext (native createTool definitions)
 *  - maxSteps: 20 (equivalent to recursionLimit: 60 / 3 nodes per cycle)
 *
 * RequestContext access uses `asWorkflowContext()` for fully typed, zero-any access.
 */
export const chatReasoningAgent = new Agent({
  id: 'chat-reasoning-agent',
  name: 'Chat Reasoning Agent',
  instructions: async ({requestContext}: {requestContext: RequestContext}) => {
    const ctx = asWorkflowContext(requestContext);
    const systemCtx = ctx.get('systemContext');
    const additionalContext = systemCtx?.join('\n') ?? '';
    return [
      `You are a helpful AI assistant. You MUST always use one of the available tools to handle the user's request. Never respond with just text on the first message — always call the closest matching tool, even if you are unsure.`,
      `Only use a single tool in a single message, but you can use multiple tools over subsequent messages if it could help with the user's requirements.`,
      `If the user provides feedback, you can use that feedback to improve the result.`,
      `Do not write any redundant messages before or after tool calls, be as concise as possible.`,
      `Do not hallucinate details or make up information.`,
      `Do not make assumptions about user's intent beyond what is explicitly provided in the prompt.`,
      `Current date is ${new Date().toDateString()}`,
      additionalContext,
    ]
      .filter(Boolean)
      .join('\n');
  },
  model: ({
    requestContext,
  }: {
    requestContext: RequestContext;
  }): MastraModelConfig => {
    const ctx = asWorkflowContext(requestContext);
    const llm: MastraLanguageModel = ctx.get('mastraChatLlm');
    if (!llm) {
      throw new Error(
        'MastraChatLLM not found in RequestContext. ' +
          'Bind AiIntegrationBindings.MastraChatLLM in your LoopBack application.',
      );
    }
    return llm;
  },
  tools: async ({requestContext}: {requestContext: RequestContext}) => {
    const ctx = asWorkflowContext(requestContext);
    const mastraTools: MastraToolStore = ctx.get('mastraTools');
    if (!mastraTools?.list?.length) {
      return {};
    }
    return mastraTools.tools;
  },
});

/**
 * Emit a Tool event to the AsyncEventQueue.
 * Called when the agent starts executing a tool call.
 */
export function emitToolStartEvent(
  eventQueue: AsyncEventQueue,
  toolCallId: string,
  toolName: string,
  args: JsonObject,
): void {
  eventQueue.push({
    type: LLMStreamEventType.Tool,
    data: {
      id: toolCallId,
      tool: toolName,
      data: args,
    },
  });
}

/**
 * Emit a ToolStatus event to the AsyncEventQueue.
 * Called after a tool call completes (or fails).
 */
export function emitToolStatusEvent(
  eventQueue: AsyncEventQueue,
  toolCallId: string,
  toolStore: MastraToolStore,
  toolName: string,
  result: JsonObject,
): void {
  const toolDefinition = toolStore.map[toolName];
  const metadata = toolDefinition?.getMetadata?.(result) ?? {};
  const status =
    typeof metadata['status'] === 'string' ? metadata['status'] : 'completed';

  eventQueue.push({
    type: LLMStreamEventType.ToolStatus,
    data: {
      id: toolCallId,
      status,
      data: metadata,
    },
  });
}

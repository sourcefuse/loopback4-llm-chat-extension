import {Agent} from '@mastra/core/agent';
import {RequestContext} from '@mastra/core/request-context';
import type {MastraLanguageModel} from '@mastra/core/agent';
import type {MastraModelConfig} from '@mastra/core/llm';
import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import {AnyObject} from '@loopback/repository';
import {IGraphTool, ToolStatus} from '../../graphs/types';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs/event.types';
import type {AsyncEventQueue} from '../bridge/async-event-queue';
import type {ToolStore} from '../../types';
import {asWorkflowContext} from '../bridge/workflow-request-context';

const debug = require('debug')('ai-integration:mastra:chat-agent');

/**
 * Typed interface for the LangChain tool extracted via igraphTool.build().
 * Only the fields we need are declared.
 */
interface LangChainToolLike {
  schema?: z.ZodTypeAny;
  description?: string;
  invoke(
    input: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Build a Mastra-compatible tool from an IGraphTool instance.
 *
 * The adapter:
 * 1. Builds the LangChain tool once (to extract the Zod schema and description).
 * 2. Returns a Mastra createTool() with the same schema.
 * 3. At execution time, re-builds with a config that routes config.writer → AsyncEventQueue.
 */
async function buildMastraToolFromIGraphTool(
  igraphTool: IGraphTool,
): Promise<ReturnType<typeof createTool>> {
  // Build once with a minimal config to extract the schema and description.
  // IGraphTool.build() is typed to accept LangGraphRunnableConfig — we pass the
  // minimum required shape.
  const lcTool = (await igraphTool.build({
    configurable: {},
  } as Parameters<IGraphTool['build']>[0])) as unknown as LangChainToolLike;

  const toolSchema: z.ZodTypeAny = lcTool.schema ?? z.record(z.unknown());
  const toolDescription: string = lcTool.description ?? igraphTool.key;

  return createTool({
    id: igraphTool.key,
    description: toolDescription,
    inputSchema: toolSchema,
    execute: async (inputData, context) => {
      // Retrieve the event queue from RequestContext (typed access via asWorkflowContext).
      const eventQueue: AsyncEventQueue | undefined = context?.requestContext
        ? asWorkflowContext(context.requestContext as RequestContext).get(
            'eventQueue',
          )
        : undefined;

      debug(`Executing tool: ${igraphTool.key}`, inputData);

      // Build a LangGraph-compatible config so tool sub-graphs can emit SSE events
      // via config.writer — those events are routed into the AsyncEventQueue.
      const lgConfig: Parameters<IGraphTool['build']>[0] = {
        configurable: {},
        writer: (event: LLMStreamEvent) => {
          eventQueue?.push(event);
        },
      } as unknown as Parameters<IGraphTool['build']>[0];

      // Re-build with writer so sub-graphs can emit events during tool execution.
      const freshLcTool = (await igraphTool.build(
        lgConfig,
      )) as unknown as LangChainToolLike;

      const result = await freshLcTool.invoke(
        inputData as Record<string, unknown>,
        lgConfig as Record<string, unknown>,
      );

      return result as AnyObject;
    },
  });
}

/**
 * Build the Mastra tools map for the ChatReasoningAgent.
 * Called once per request from AgentReasoningStep.
 */
export async function buildChatAgentTools(
  toolStore: ToolStore,
): Promise<Record<string, ReturnType<typeof createTool>>> {
  const toolsMap: Record<string, ReturnType<typeof createTool>> = {};

  for (const igraphTool of toolStore.list) {
    if (igraphTool.needsReview === true) {
      debug(`Skipping tool ${igraphTool.key}: requires user review`);
      continue;
    }
    try {
      toolsMap[igraphTool.key] =
        await buildMastraToolFromIGraphTool(igraphTool);
    } catch (err) {
      debug(`Failed to build Mastra tool wrapper for ${igraphTool.key}:`, err);
    }
  }

  return toolsMap;
}

/**
 * ChatReasoningAgent — the Mastra Agent that drives the multi-turn tool-calling loop.
 *
 * Replaces the CallLLM → RunTool → TrimMessages cycle in the original ChatGraph.
 * The model and tools are resolved dynamically from RequestContext at runtime.
 *
 * Architecture:
 *  - model: resolved from RequestContext at each call (supports per-request model injection)
 *  - tools: built from the ToolStore in RequestContext (adapts IGraphTool → Mastra tools)
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
    const toolStore: ToolStore = ctx.get('toolStore');
    if (!toolStore?.list?.length) {
      return {};
    }
    return buildChatAgentTools(toolStore);
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
  args: AnyObject,
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
  toolStore: ToolStore,
  toolName: string,
  result: AnyObject,
): void {
  const igraphTool = toolStore.map[toolName];
  const metadata =
    igraphTool?.getMetadata?.(result as Record<string, string>) ?? {};
  const status =
    (metadata['status'] as string) ??
    (result ? ToolStatus.Completed : ToolStatus.Failed);

  eventQueue.push({
    type: LLMStreamEventType.ToolStatus,
    data: {
      id: toolCallId,
      status,
      data: metadata,
    },
  });
}

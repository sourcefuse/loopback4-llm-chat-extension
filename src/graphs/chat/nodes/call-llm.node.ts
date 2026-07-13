import {inject} from '@loopback/core';
import {Mastra} from '@mastra/core';
import type {MastraModelConfig} from '@mastra/core/llm';
import {graphNode} from '../../../decorators';
import type {ChatState, IChatNode} from '../../state';
import {AiIntegrationBindings} from '../../../keys';
import {UsageAccumulator} from '../../../services/usage-accumulator.service';
import {RequestContextBuilder} from '../../../runtime/request-context.builder';
import {
  pumpAgentStream,
  type AgentStreamResult,
} from '../../../runtime/bridge/agent-stream';
import {modelLabel} from '../../../runtime/model-resolver';
import {
  buildProviderOptions,
  resolveEnvTemperature,
} from '../../../components/db-query/_helpers';
import {ChatNodes} from '../nodes.enum';

// Cap the chat agent's tool-calling loop. One data/chart/dataset request needs
// at most: decide-tool → (tool runs) → summarise = ~2-3 LLM steps. The old
// LangGraph recursionLimit of 60 let the model re-call tools and over-reason;
// a tight cap keeps it a deterministic one-tool pipeline. Headroom for a clarify
// step.
const MAX_AGENT_STEPS = 8;

/**
 * Call the LLM and run its tool loop — the LangGraph `CallLLMNode`. On Mastra
 * this single node owns what LangGraph split across `CallLLM`, `RunTool` and
 * `TrimMessages`: `agent.stream({maxSteps})` invokes the model, executes any
 * tool-calls and trims context in one streaming loop (see {@link RunToolNode} /
 * {@link ContextCompressionNode} — the override seams for those phases).
 *
 * Thin like the LangGraph node: it injects its collaborators — the registered
 * Mastra agent, the {@link RequestContextBuilder} (RequestContext assembly) and
 * the UsageAccumulator — and delegates the Mastra-specific plumbing to the
 * runtime bridge ({@link pumpAgentStream}) rather than owning it. A host
 * overrides it by rebinding `@graphNode(ChatNodes.CallLLM)`.
 */
@graphNode(ChatNodes.CallLLM)
export class CallLLMNode implements IChatNode {
  // Stream one Message per text delta (progressive) when
  // MASTRA_STREAM_TOKENS=true; default OFF coalesces into one terminal Message
  // (LangGraph parity — its call-llm emitted one Message after a blocking call).
  protected readonly streamTokens = process.env.MASTRA_STREAM_TOKENS === 'true';

  constructor(
    @inject(AiIntegrationBindings.Mastra) protected readonly mastra: Mastra,
    @inject('services.RequestContextBuilder')
    protected readonly rcBuilder: RequestContextBuilder,
    @inject(AiIntegrationBindings.ChatLLM, {optional: true})
    protected readonly chatLlm?: MastraModelConfig,
    @inject('services.UsageAccumulator', {optional: true})
    protected readonly usage?: UsageAccumulator,
  ) {}

  async execute(state: ChatState): Promise<Partial<ChatState>> {
    // Stream the chatAgent REGISTERED on the Mastra singleton so its spans reach
    // the configured observability exporter.
    const agent = this.mastra.getAgent('chatAgent');
    if (!agent) {
      return {
        error: 'ChatAgent not registered in Mastra — check Provider boot order',
      };
    }

    const requestContext = await this.rcBuilder.build({
      resourceId: state.resourceId ?? '',
      eventWriter: state.push,
    });

    // `providerOptions` carries Anthropic/Bedrock thinking config from
    // CLAUDE_THINKING(_BUDGET) env (LangGraph parity); no-op elsewhere.
    const providerOptions = buildProviderOptions();
    const temperature = resolveEnvTemperature();
    const streamPromise = agent.stream(
      [{role: 'user', content: state.augmentedQuery ?? state.query}],
      {
        maxSteps: MAX_AGENT_STEPS,
        abortSignal: state.abort,
        requestContext,
        memory: {
          thread: state.threadId ?? '',
          resource: state.resourceId ?? '',
        },
        ...(temperature === undefined ? {} : {temperature}),
        ...(providerOptions ? {providerOptions: providerOptions as never} : {}),
      },
    ) as Promise<AgentStreamResult>;

    return pumpAgentStream(streamPromise, state.push, {
      streamTokens: this.streamTokens,
      usage: this.usage,
      usageLabel: modelLabel(this.chatLlm),
    });
  }
}

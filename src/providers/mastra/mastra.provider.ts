import {BindingScope, inject, injectable, Provider} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {Agent} from '@mastra/core/agent';
import {Memory} from '@mastra/memory';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraEmbeddingModel, MastraVector} from '@mastra/core/vector';
import type {MastraModelConfig} from '@mastra/core/llm';
import type {Tool} from '@mastra/core/tools';
import type {RequestContext} from '@mastra/core/request-context';
import type {Observability} from '@mastra/observability';
import {AiIntegrationBindings} from '../../keys';
import {createMaxTokenCountProcessor} from '../../mastra/processors/max-token-count.processor';
import {generateQueryWorkflow} from '../../mastra/workflows/db-query/generate.workflow';
import {improveQueryWorkflow} from '../../mastra/workflows/db-query/improve.workflow';
import {visualizationWorkflow} from '../../mastra/workflows/visualization.workflow';

/**
 * Singleton Mastra instance. Holds storage pools, vector clients, registered
 * Agents, and observability exporters. Per-request DI (resourceId, eventWriter,
 * dbConnector) flows through `agent.stream({requestContext})` invoked by the
 * REQUEST-scoped WorkflowRunner — NOT by spinning a new Mastra per request.
 *
 * The ChatAgent registered here is the canonical one streamed by
 * WorkflowRunner via `mastra.getAgent('chatAgent')`. Its model, tools and
 * instructions are resolved per request from RequestContext (see below),
 * so it stays registered with this instance and keeps emitting traces.
 *
 * + 7.4.
 */
@injectable({scope: BindingScope.SINGLETON})
export class MastraProvider implements Provider<Mastra> {
  constructor(
    @inject(AiIntegrationBindings.MastraStorage)
    private storage: MastraCompositeStore,
    @inject(AiIntegrationBindings.MastraVectorStore, {optional: true})
    private vector?: MastraVector,
    @inject(AiIntegrationBindings.MastraEmbedder, {optional: true})
    private embedder?: MastraEmbeddingModel<string>,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    private systemContext?: string[],
    @inject(AiIntegrationBindings.MastraObservability, {optional: true})
    private observability?: Observability,
  ) {}

  async value(): Promise<Mastra> {
    // Thread-title generation fires a SECOND LLM call after `memory: save`
    // on the first turn of each new thread (visible as a small extra
    // `llm: openai/gpt-4o` span in Langfuse/LangSmith after the main one).
    // It's a Mastra-only cost — the v2 LangGraph extension had no thread
    // title concept at all. Default OFF so consumers don't pay for it
    // silently; opt in with `MASTRA_GENERATE_TITLE=true`. When enabled,
    // `MASTRA_TITLE_MODEL` lets the consumer route the title call to a
    // cheaper model (e.g. "openai/gpt-4o-mini") to keep the cost trivial.
    const generateTitle = buildGenerateTitleOption();
    const memory = new Memory({
      storage: this.storage,
      vector: this.vector ?? false,
      embedder: this.embedder,
      options: {
        lastMessages: 20,
        semanticRecall:
          this.vector && this.embedder
            ? {topK: 5, messageRange: 3, scope: 'resource'}
            : false,
        workingMemory: {enabled: false},
        generateTitle,
      },
    });

    // Fail-closed model resolution. Requiring an explicit
    // MASTRA_DEFAULT_CHAT_MODEL env var prevents silent OpenAI billing when
    // OPENAI_API_KEY happens to be present in the consumer env.
    const defaultModel = process.env.MASTRA_DEFAULT_CHAT_MODEL;
    if (!defaultModel) {
      throw new Error(
        'MastraProvider: set MASTRA_DEFAULT_CHAT_MODEL env var ' +
          '(e.g. "google/gemini-1.5-flash", "anthropic/claude-3-5-sonnet-20241022") ' +
          'or override MastraProvider entirely. The ChatAgent has no ' +
          'silent default model — refusing to ship a billable OpenAI fallback.',
      );
    }
    const defaultInstructions = [
      'You are a helpful AI assistant. Always use one of the available tools if applicable.',
      ...(this.systemContext ?? []),
    ].join('\n');

    // Dynamic, request-resolved ChatAgent. The REQUEST-scoped WorkflowRunner
    // streams THIS registered agent (via `mastra.getAgent('chatAgent')`) and
    // passes the per-request model / tools / instructions through
    // RequestContext. Resolving them via function-typed params — instead of
    // constructing a detached `new Agent()` per request — keeps the agent
    // bound to this Mastra instance, so its spans flow to the configured
    // observability exporter (Langfuse). A detached agent emits no traces.
    // Falls back to the singleton defaults on out-of-band paths (Studio,
    // MCP exposure) where no RequestContext is present.
    const pick = <T>(
      rc: RequestContext | undefined,
      key: string,
    ): T | undefined => rc?.get(key) as T | undefined;
    // Drop-in for the v2 LangGraph `ContextCompressionNode` — trims oldest
    // non-system messages when running token count exceeds MAX_TOKEN_COUNT
    // (env or AIIntegrationConfig.maxTokenCount, default 8192). Stays inert
    // when no env is set and message count is small.
    const maxTokenCountProcessor = createMaxTokenCountProcessor();
    const chatAgent = new Agent({
      id: 'chat-agent',
      name: 'ChatAgent',
      instructions: ({requestContext}) =>
        pick<string>(requestContext, 'agentInstructions') ??
        defaultInstructions,
      model: ({requestContext}) =>
        pick<MastraModelConfig>(requestContext, 'agentModel') ?? defaultModel,
      tools: ({requestContext}) =>
        pick<Record<string, Tool>>(requestContext, 'agentTools') ?? {},
      memory,
      inputProcessors: [maxTokenCountProcessor],
    });

    return new Mastra({
      agents: {chatAgent},
      workflows: {
        generateQueryWorkflow,
        improveQueryWorkflow,
        visualizationWorkflow,
      },
      storage: this.storage,
      vectors: this.vector ? {default: this.vector} : undefined,
      observability: this.observability,
    });
  }
}

/**
 * Resolve `generateTitle` from env. Default: `false` — saves an extra LLM
 * call per new thread, matching v2 LangGraph extension cost.
 *
 * - `MASTRA_GENERATE_TITLE=true` → enable. Without `MASTRA_TITLE_MODEL`,
 *   Mastra uses the agent's main chat model.
 * - `MASTRA_GENERATE_TITLE=true` + `MASTRA_TITLE_MODEL=openai/gpt-4o-mini`
 *   → enable AND route the title call to the cheaper model.
 */
function buildGenerateTitleOption():
  | boolean
  | {model: MastraModelConfig; instructions?: string} {
  if (process.env.MASTRA_GENERATE_TITLE !== 'true') return false;
  const titleModel = process.env.MASTRA_TITLE_MODEL;
  if (!titleModel) return true;
  return {model: titleModel as MastraModelConfig};
}

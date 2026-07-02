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
import {TokenLimiter} from '@mastra/core/processors';
import {buildChatInstructions} from '../../runtime/chat-agent-instructions';
import {DEFAULT_MAX_TOKEN_COUNT} from '../../constant';
import {generateQueryWorkflow} from '../../components/db-query/workflows/generate.workflow';
import {improveQueryWorkflow} from '../../components/db-query/workflows/improve.workflow';
import {visualizationWorkflow} from '../../components/visualization/workflows/visualization.workflow';

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
    @inject(AiIntegrationBindings.Storage)
    private storage: MastraCompositeStore,
    @inject(AiIntegrationBindings.VectorStore, {optional: true})
    private vector?: MastraVector,
    @inject(AiIntegrationBindings.EmbeddingModel, {optional: true})
    private embedder?: MastraEmbeddingModel<string>,
    @inject(AiIntegrationBindings.SystemContext, {optional: true})
    private systemContext?: string[],
    @inject(AiIntegrationBindings.Observability, {optional: true})
    private observability?: Observability,
    // v2 host-facing seam: a consumer that binds AiIntegrationBindings.ObfHandler
    // (the mastra equivalent of v2's langfuse ObfHandler) gets it folded into
    // the Mastra instance's observability when no internal Observability is
    // bound. Prefer the dedicated Observability binding when both are present.
    @inject(AiIntegrationBindings.ObfHandler, {optional: true})
    private obfHandler?: Observability,
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
        semanticRecall: buildSemanticRecallOption(
          Boolean(this.vector && this.embedder),
        ),
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
    // Ports the v2 LangGraph chat system prompt (init-session.node): force a
    // tool call on the first turn — the model is far more reliable at tool
    // selection when it has no "just reply with text" escape hatch, and the
    // tool rejects anything unsuitable. The earlier softer wording let weaker
    // chat models (e.g. gemini-2.5-flash) narrate instead of calling the tool,
    // and assume a chart was wanted when it wasn't.
    // Fallback instructions for out-of-band paths (Studio / MCP) with no
    // per-request RequestContext. buildChatInstructions adds the current date
    // (v2 init-session parity) and appends host systemContext; computed inside
    // the agent's instructions function below so the date stays fresh on a
    // long-lived process.
    const systemContext = this.systemContext;

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
    // TokenLimiter trims the oldest non-system messages to fit `tokenBudget`.
    // Budget must exceed the system prompt (directives + host systemContext) —
    // the limiter cannot trim system messages, so a too-low budget HARD-BLOCKS
    // the request. Default (DEFAULT_MAX_TOKEN_COUNT) is sized for that; override
    // with MAX_TOKEN_COUNT only to a value that still clears your system prompt.
    const tokenBudget = process.env.MAX_TOKEN_COUNT
      ? Number.parseInt(process.env.MAX_TOKEN_COUNT, 10)
      : DEFAULT_MAX_TOKEN_COUNT;
    const maxTokenCountProcessor = new TokenLimiter(tokenBudget);
    const chatAgent = new Agent({
      id: 'chat-agent',
      name: 'ChatAgent',
      instructions: ({requestContext}) =>
        pick<string>(requestContext, 'agentInstructions') ??
        buildChatInstructions(systemContext),
      model: ({requestContext}) =>
        pick<MastraModelConfig>(requestContext, 'agentModel') ?? defaultModel,
      tools: ({requestContext}) =>
        pick<Record<string, Tool>>(requestContext, 'agentTools') ?? {},
      memory,
      inputProcessors: [maxTokenCountProcessor],
    });

    // One-shot Q&A agent for the ask-about-dataset tool. Registered on the
    // singleton (not constructed per-call) so its spans reach the configured
    // observability exporter. Uses the same dynamic model resolver as chatAgent
    // so it follows the per-request model binding when called from a tool.
    const askAboutDatasetAgent = new Agent({
      id: 'ask-about-dataset-agent',
      name: 'AskAboutDatasetAgent',
      instructions:
        'Answer the user question concisely. Do not reveal the underlying SQL or schema details.',
      model: ({requestContext}) =>
        pick<MastraModelConfig>(requestContext, 'agentModel') ?? defaultModel,
    });

    return new Mastra({
      agents: {chatAgent, askAboutDatasetAgent},
      workflows: {
        generateQueryWorkflow,
        improveQueryWorkflow,
        visualizationWorkflow,
      },
      storage: this.storage,
      vectors: this.vector ? {default: this.vector} : undefined,
      observability: this.observability ?? this.obfHandler,
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
/**
 * Resolve Memory `semanticRecall` from env. Default: `false`.
 *
 * Semantic recall is a Mastra capability with NO v2 LangGraph equivalent —
 * v2's `ContextCompressionNode` only trimmed to the last N messages; it never
 * recalled older messages by similarity. Leaving it ON whenever a vector store
 * happens to be bound is a silent trap: consumers bind a vector store for the
 * db-query CACHE, and Memory would piggy-back on the SAME binding to enable
 * cross-thread chat recall. At `scope: 'resource'` that recall scans the
 * resource's ENTIRE message history, which grows every request — so latency
 * climbs over a session (observed in Langfuse/LangSmith) and the cost is paid
 * silently. Mirrors the default-OFF treatment of `generateTitle` /
 * `workingMemory`.
 *
 * Opt in with `MASTRA_SEMANTIC_RECALL=true` (requires a bound vector store +
 * embedder; otherwise stays `false`). Tunables:
 *   - `MASTRA_SEMANTIC_RECALL_TOPK` (default 5)
 *   - `MASTRA_SEMANTIC_RECALL_RANGE` (messageRange, default 3)
 * Scope is fixed to `'resource'` for multi-tenant isolation (Section 13.7).
 */
const DEFAULT_SEMANTIC_RECALL_TOPK = 5;
const DEFAULT_SEMANTIC_RECALL_RANGE = 3;

function buildSemanticRecallOption(
  hasVectorAndEmbedder: boolean,
): false | {topK: number; messageRange: number; scope: 'resource'} {
  if (process.env.MASTRA_SEMANTIC_RECALL !== 'true') return false;
  if (!hasVectorAndEmbedder) return false;
  const toInt = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    topK: toInt(
      process.env.MASTRA_SEMANTIC_RECALL_TOPK,
      DEFAULT_SEMANTIC_RECALL_TOPK,
    ),
    messageRange: toInt(
      process.env.MASTRA_SEMANTIC_RECALL_RANGE,
      DEFAULT_SEMANTIC_RECALL_RANGE,
    ),
    scope: 'resource',
  };
}

function buildGenerateTitleOption():
  | boolean
  | {model: MastraModelConfig; instructions?: string} {
  if (process.env.MASTRA_GENERATE_TITLE !== 'true') return false;
  const titleModel = process.env.MASTRA_TITLE_MODEL;
  if (!titleModel) return true;
  return {model: titleModel as MastraModelConfig};
}

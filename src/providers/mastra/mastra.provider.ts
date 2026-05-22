import {BindingScope, inject, injectable, Provider} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {Agent} from '@mastra/core/agent';
import {Memory} from '@mastra/memory';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraEmbeddingModel, MastraVector} from '@mastra/core/vector';
import type {Observability} from '@mastra/observability';
import {AiIntegrationBindings} from '../../keys';
import {generateQueryWorkflow} from '../../mastra/workflows/db-query/generate.workflow';
import {improveQueryWorkflow} from '../../mastra/workflows/db-query/improve.workflow';
import {visualizationWorkflow} from '../../mastra/workflows/visualization.workflow';

/**
 * Singleton Mastra instance. Holds storage pools, vector clients, registered
 * Agents, and observability exporters. Per-request DI (resourceId, eventWriter,
 * dbConnector) flows through `agent.stream({requestContext})` invoked by the
 * REQUEST-scoped WorkflowRunner — NOT by spinning a new Mastra per request.
 *
 * The ChatAgent registered here is the canonical one (used by Studio/MCP/
 * observability + by WorkflowRunner.buildAgent() which reuses its Memory).
 * Tools are wired in P1.11 once the 4 internal tools migrate to createTool;
 * during P1 setup the agent boots with an empty tool map.
 *
 * Section 3.3 + 7.4.
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
        generateTitle: true,
      },
    });

    // Placeholder model for the singleton ChatAgent. WorkflowRunner
    // builds its own per-request Agent with the consumer-bound
    // MastraChatLLM, so the singleton's model is only consulted on
    // out-of-band paths (Mastra Studio, MCP exposure, observability
    // probes). Consumers may override the placeholder by binding
    // `AiIntegrationBindings.MastraChatLLM` to a known model
    // (recommended) — if OPENAI_API_KEY is present in the
    // environment AND the singleton agent is invoked through one of
    // those out-of-band paths, the literal 'openai/gpt-4o-mini' default
    // here WILL bill against the consumer's OpenAI account. To avoid
    // surprise spend, set OPENAI_API_KEY only when you intentionally
    // route to OpenAI, or pin a non-OpenAI model id here via a
    // consumer-side MastraProvider override.
    const chatAgent = new Agent({
      id: 'chat-agent',
      name: 'ChatAgent',
      instructions: [
        'You are a helpful AI assistant. Always use one of the available tools if applicable.',
        ...(this.systemContext ?? []),
      ].join('\n'),
      model: process.env.MASTRA_DEFAULT_CHAT_MODEL ?? 'openai/gpt-4o-mini',
      tools: {},
      memory,
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

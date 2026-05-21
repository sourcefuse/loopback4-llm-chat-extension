import {BindingScope, inject, injectable, Provider} from '@loopback/core';
import {Mastra} from '@mastra/core/mastra';
import type {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraEmbeddingModel, MastraVector} from '@mastra/core/vector';
import {Memory} from '@mastra/memory';
import {createChatReasoningAgent} from '../../mastra/agents/chat-reasoning.agent';
import {AiIntegrationBindings} from '../../keys';

@injectable({scope: BindingScope.SINGLETON})
export class MastraProvider implements Provider<Mastra> {
  constructor(
    @inject(AiIntegrationBindings.MastraStorage)
    private readonly storage: MastraCompositeStore,
    @inject(AiIntegrationBindings.MastraVectorStore, {optional: true})
    private readonly vectorStore?: MastraVector,
    @inject(AiIntegrationBindings.MastraEmbedder, {optional: true})
    private readonly embedder?: MastraEmbeddingModel<string>,
  ) {}

  async value(): Promise<Mastra> {
    const memory = new Memory({
      storage: this.storage,
      vector: this.vectorStore,
      embedder: this.embedder,
      options: {
        lastMessages: 20,
        generateTitle: true,
        semanticRecall:
          this.vectorStore && this.embedder
            ? {
                topK: 5,
                messageRange: 3,
                scope: 'resource',
              }
            : false,
        workingMemory: {
          enabled: false,
        },
      },
    });

    const chatAgent = createChatReasoningAgent(memory);

    return new Mastra({
      agents: {
        chatAgent,
      },
      storage: this.storage,
      vectors: this.vectorStore
        ? {
            default: this.vectorStore,
          }
        : undefined,
    });
  }
}

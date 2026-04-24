import {VectorStore as VectorStoreType} from '@langchain/core/vectorstores';
import {BindingKey} from '@loopback/context';
import {
  IMastraBridge,
  MastraRuntimeFactory as MastraRuntimeFactoryType,
} from './services/mastra-bridge.service';
import {ITransport} from './transports/types';
import {
  AIIntegrationConfig,
  EmbeddingProvider,
  ICache,
  IWorkflowPersistence,
  RuntimeLLMProvider,
  ToolStore,
} from './types';
import {ILimitStrategy} from './services/limit-strategies/types';

export namespace AiIntegrationBindings {
  export const Config = BindingKey.create<AIIntegrationConfig>(
    'services.ai-reporting.config',
  );
  export const SmartLLM = BindingKey.create<RuntimeLLMProvider>(
    'services.ai-reporting.smartLLMProvider',
  );
  export const CheapLLM = BindingKey.create<RuntimeLLMProvider>(
    'services.ai-reporting.cheapLLMProvider',
  );
  export const FileLLM = BindingKey.create<RuntimeLLMProvider>(
    'services.ai-reporting.fileLLMProvider',
  );
  export const ChatLLM = BindingKey.create<RuntimeLLMProvider>(
    'services.ai-reporting.chatLLMProvider',
  );
  export const SmartNonThinkingLLM = BindingKey.create<RuntimeLLMProvider>(
    'services.ai-reporting.smartNonThinkingLLMProvider',
  );
  export const EmbeddingModel = BindingKey.create<EmbeddingProvider>(
    'services.ai-reporting.embeddingModel',
  );
  export const WorkflowPersistence = BindingKey.create<IWorkflowPersistence>(
    'services.ai-reporting.workflow-persistence',
  );
  /**
   * @deprecated Use `WorkflowPersistence`.
   */
  export const Checkpointer = WorkflowPersistence;
  export const Tools = BindingKey.create<ToolStore>(
    'services.ai-reporting.tool-store',
  );
  export const Transport = BindingKey.create<ITransport>(
    'services.ai-reporting.transport',
  );
  export const VectorStore = BindingKey.create<VectorStoreType>(
    'services.ai-reporting.vector-store',
  );
  export const Cache = BindingKey.create<ICache>('services.ai-reporting.cache');
  export const LimitStrategy = BindingKey.create<ILimitStrategy>(
    'services.ai-reporting.limit-strategy',
  );
  export const ObfHandler = BindingKey.create<Function>(
    'services.ai-reporting.obf-handler',
  );
  export const MastraBridge = BindingKey.create<IMastraBridge>(
    'services.ai-reporting.mastra-bridge',
  );
  export const MastraRuntimeFactory =
    BindingKey.create<MastraRuntimeFactoryType>(
      'services.ai-reporting.mastra-runtime-factory',
    );
  export const SystemContext = BindingKey.create<string[]>(
    `services.ai-reporting.system-context`,
  );
}
export const WriterDB = 'writerdb';
export const ReaderDB = 'readerdb';

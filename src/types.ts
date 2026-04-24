import {BedrockEmbeddings} from '@langchain/aws';
import {GoogleGenerativeAIEmbeddings} from '@langchain/google-genai';
import {OllamaEmbeddings} from '@langchain/ollama';
import {OpenAIEmbeddings} from '@langchain/openai';
import {LanguageModel} from 'ai';
import {Provider} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {AIMessage} from '@langchain/core/messages';
import {RunnableConfig, RunnableInterface} from '@langchain/core/runnables';
import {IGraphTool} from './graphs/types';

export enum SupportedDBs {
  PostgreSQL = 'PostgreSQL',
  SQLite = 'SQLite',
}

/**
 * Global component configuration consumed by the LoopBack integration component.
 */
export type AIIntegrationConfig = {
  runtime?: RuntimeEngine;
  useCustomSequence?: boolean;
  mountCore?: boolean;
  mountFileUtils?: boolean;
  mountChatControllers?: boolean;
  maxTokenCount?: number;
  writerDS?: string;
  readerDS?: string;
  tokenCounterConfig?: {
    chatLimit?: number;
    tokenLimit?: number;
    bufferTokens?: number;
    period: number; // in seconds
  };
};

/**
 * Runtime engine selector used for phased migration and rollbacks.
 */
export type RuntimeEngine = 'langgraph' | 'mastra';

export type FileMessageBuilder = (file: Express.Multer.File) => AnyObject;

/**
 * Primary provider contract for Phase 1. This maps directly to the AI SDK model contract.
 */
export type LLMProvider = LanguageModel;

/**
 * Legacy LangGraph-compatible LLM contract used by existing graph implementations.
 *
 * The structure intentionally mirrors the methods used by current nodes so concrete
 * LangChain chat models remain assignable without direct class dependencies.
 */
export type LegacyLLMProvider = {
  bindTools(
    tools: unknown[],
  ): RunnableInterface<
    unknown,
    AIMessage,
    RunnableConfig<Record<string, unknown>>
  >;
  invoke(input: unknown): Promise<AIMessage>;
  withStructuredOutput<T extends AnyObject>(
    schema: unknown,
  ): RunnableInterface<unknown, T, RunnableConfig<Record<string, unknown>>>;
  getFile?: FileMessageBuilder;
} & RunnableInterface<
  unknown,
  AIMessage,
  RunnableConfig<Record<string, unknown>>
>;

/**
 * Adapter contract for converting an AI SDK model into the legacy tool-calling interface
 * while LangGraph execution remains active.
 */
export interface ILegacyLLMProviderAdapter {
  toLegacyLLMProvider(): LegacyLLMProvider;
}

/**
 * Runtime-compatible union used by existing LangGraph execution paths during migration.
 */
export type RuntimeLLMProvider = LegacyLLMProvider &
  Partial<ILegacyLLMProviderAdapter>;

/**
 * Resolves a runtime-compatible provider into a legacy execution contract.
 */
export function resolveLegacyLLMProvider(
  provider: RuntimeLLMProvider,
): LegacyLLMProvider {
  if (provider.toLegacyLLMProvider) {
    return provider.toLegacyLLMProvider();
  }
  return provider;
}

export type EmbeddingProvider =
  | OpenAIEmbeddings
  | OllamaEmbeddings
  | BedrockEmbeddings
  | GoogleGenerativeAIEmbeddings;

/**
 * Runtime persistence contract used by workflow/checkpoint adapters.
 */
export interface IWorkflowPersistence {
  save(runId: string, state: AnyObject): Promise<void>;
  load(runId: string): Promise<AnyObject | undefined>;
}

/**
 * Provider contract for workflow persistence adapters.
 */
export type WorkflowPersistenceProvider = Provider<IWorkflowPersistence>;

/**
 * @deprecated Use `WorkflowPersistenceProvider`.
 */
export type CheckpointerProvider = WorkflowPersistenceProvider;

export type ToolStore = {
  list: IGraphTool[];
  map: Record<string, IGraphTool>;
};

export enum ChannelType {
  Chat = 'chat',
}

export interface ICache {
  set<T = AnyObject>(key: string, value: T): Promise<void>;
  get<T = AnyObject>(key: string): Promise<T | null>;
}

export type TokenMetadata = {
  [key: string]: {
    inputTokens: number;
    outputTokens: number;
  };
};

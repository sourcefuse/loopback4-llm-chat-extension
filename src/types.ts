import {EmbeddingModel, LanguageModel} from 'ai';
import {Provider} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {IGraphTool} from './types/tool';

export enum SupportedDBs {
  PostgreSQL = 'PostgreSQL',
  SQLite = 'SQLite',
}

/**
 * Global component configuration consumed by the LoopBack integration component.
 */
export type AIIntegrationConfig = {
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

export type FileMessageBuilder = (file: Express.Multer.File) => AnyObject;

/**
 * Primary provider contract for Phase 1. This maps directly to the AI SDK model contract.
 */
export type LLMProvider = LanguageModel;

/**
 * @deprecated Use `AiSdkEmbeddingModel` instead. Kept for backward compatibility.
 */
export type EmbeddingProvider = EmbeddingModel;

/**
 * AI SDK embedding model type for the Mastra execution path.
 * Zero LangChain dependency — use with `embed()` / `embedMany()` from `'ai'`.
 * Bind an instance to `AiIntegrationBindings.AiSdkEmbeddingModel`.
 */
export type AiSdkEmbeddingModel = EmbeddingModel;

/**
 * Mastra-path vector store document.
 *
 * Property names mirror `DocumentInterface` from `@langchain/core/documents` so that
 * existing Mastra step callers (`doc.pageContent`, `doc.metadata`) need no changes.
 */
export interface IVectorStoreDocument<T = Record<string, unknown>> {
  /** The textual content of the document. */
  pageContent: string;
  /** Arbitrary key-value metadata attached to the document. */
  metadata: T;
}

/**
 * Mastra-compatible vector store contract — zero LangChain dependency.
 *
 * Implemented by `PgVectorSdkStore` for the Mastra execution path.
 * The LangGraph path continues to use `VectorStore` from `@langchain/core/vectorstores`.
 */
export interface IVectorStore {
  /**
   * Persist documents (text + metadata) to the underlying store.
   * Embeddings are computed internally via the configured AI SDK embedding model.
   */
  addDocuments(docs: IVectorStoreDocument[]): Promise<void>;
  /**
   * Return the `k` most semantically similar documents to `query`,
   * optionally filtered by `filter` (matched against document metadata via JSON containment).
   */
  similaritySearch<T = Record<string, unknown>>(
    query: string,
    k: number,
    filter?: Record<string, unknown>,
  ): Promise<IVectorStoreDocument<T>[]>;
  /**
   * Delete all documents whose metadata contains every key-value pair in `params.filter`.
   */
  delete(params: {filter: Record<string, unknown>}): Promise<void>;
}

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

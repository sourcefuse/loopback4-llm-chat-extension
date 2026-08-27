import {type EmbeddingModel, type LanguageModel} from 'ai';
import {type MastraStorage} from '@mastra/core/storage';
import {Provider} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {IGraphTool} from './graphs/types';

export enum SupportedDBs {
  PostgreSQL = 'PostgreSQL',
  SQLite = 'SQLite',
}

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

/** Per-call model settings carried on a provider (temperature, reasoning, etc.). */
export type ModelDefaultSettings = {
  temperature?: number;
  maxOutputTokens?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

/**
 * An AI SDK language model, optionally augmented with a provider-specific file
 * builder (e.g. Bedrock PDF parts) and default per-call settings. The binding
 * keys (`SmartLLM`, `CheapLLM`, ...) are unchanged; only the value type moved
 * from a LangChain chat model to an AI SDK model.
 */
export type LLMProviderType = LanguageModel;

export type LLMProvider = LLMProviderType & {
  getFile?: FileMessageBuilder;
  defaultSettings?: ModelDefaultSettings;
};

export type EmbeddingProvider = EmbeddingModel;

export type CheckpointerProvider = Provider<MastraStorage>;

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

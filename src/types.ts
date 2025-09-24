import {ChatAnthropic} from '@langchain/anthropic';
import {BedrockEmbeddings, ChatBedrockConverse} from '@langchain/aws';
import {ChatCerebras} from '@langchain/cerebras';
import {
  ChatGoogleGenerativeAI,
  GoogleGenerativeAIEmbeddings,
} from '@langchain/google-genai';
import {BaseCheckpointSaver} from '@langchain/langgraph';
import {ChatOllama, OllamaEmbeddings} from '@langchain/ollama';
import {ChatOpenAI, OpenAIEmbeddings} from '@langchain/openai';
import {Provider} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {IGraphTool} from './graphs/types';
import {ChatGroq} from '@langchain/groq';

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

export type LLMProviderType =
  | ChatOllama
  | ChatCerebras
  | ChatOpenAI
  | ChatAnthropic
  | ChatBedrockConverse
  | ChatGoogleGenerativeAI
  | ChatGroq;

export type LLMProvider = LLMProviderType & {
  getFile?: FileMessageBuilder;
};

export type EmbeddingProvider =
  | OpenAIEmbeddings
  | OllamaEmbeddings
  | BedrockEmbeddings
  | GoogleGenerativeAIEmbeddings;

export type CheckpointerProvider = Provider<BaseCheckpointSaver>;

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

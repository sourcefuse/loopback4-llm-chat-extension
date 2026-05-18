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
import {createTool} from '@mastra/core/tools';
import {Provider} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {IGraphTool} from './graphs/types';
import {ChatGroq} from '@langchain/groq';
import {ChatOpenRouter} from '@langchain/openrouter';

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
  | ChatGroq
  | ChatOpenRouter;

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

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

export type MastraTool = ReturnType<typeof createTool>;

export type MastraToolDefinition = {
  id: string;
  tool: MastraTool;
  source: 'native' | 'legacy-compat';
  formatResult: (result: JsonObject) => string;
  getMetadata: (result: JsonObject) => JsonObject;
};

export type MastraToolStore = {
  list: MastraToolDefinition[];
  map: Record<string, MastraToolDefinition>;
  tools: Record<string, MastraTool>;
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

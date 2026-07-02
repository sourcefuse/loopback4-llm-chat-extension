import type {EmbeddingModel, LanguageModel} from 'ai';
import {AnyObject} from '@loopback/repository';

export enum SupportedDBs {
  PostgreSQL = 'PostgreSQL',
  SQLite = 'SQLite',
}

/**
 * Selects the Mastra storage backend (threads/messages persistence). Configured
 * inline on {@link AIIntegrationConfig} — the same way `writerDS`/`readerDS` are
 * — rather than through a separate component or the internal Storage binding.
 * Defaults to LibSQL/SQLite when omitted, so zero-config stays the default.
 */
export type MastraStorageConfig = {
  // 'libsql' (default) writes a local SQLite file; 'postgres' persists in
  // Postgres via @mastra/pg.
  type?: 'libsql' | 'postgres';
  // libsql: file/url (falls back to MASTRA_STORAGE_URL, then `file:./mastra.db`).
  // postgres: connection string (falls back to MASTRA_PG_CONNECTION_STRING).
  connectionString?: string;
  // postgres only — schema for the mastra_* tables (default `mastra`).
  schema?: string;
  // postgres only — enable TLS.
  ssl?: boolean;
};

export type AIIntegrationConfig = {
  useCustomSequence?: boolean;
  mountCore?: boolean;
  mountFileUtils?: boolean;
  mountChatControllers?: boolean;
  maxTokenCount?: number;
  writerDS?: string;
  readerDS?: string;
  // Mastra storage backend (threads/messages). Omit for zero-config LibSQL.
  storage?: MastraStorageConfig;
  tokenCounterConfig?: {
    chatLimit?: number;
    tokenLimit?: number;
    bufferTokens?: number;
    period: number; // in seconds
  };
};

export type FileMessageBuilder = (file: Express.Multer.File) => AnyObject;

export type LLMProvider = LanguageModel;

export type EmbeddingProvider = EmbeddingModel;

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

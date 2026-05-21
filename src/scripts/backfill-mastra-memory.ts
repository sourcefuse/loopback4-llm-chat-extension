import * as path from 'path';
import {randomUUID} from 'crypto';
import {Application} from '@loopback/core';
import {MastraCompositeStore} from '@mastra/core/storage';
import type {MastraDBMessage, StorageThreadType} from '@mastra/core/memory';
import {AiIntegrationBindings} from '../keys';
import {MessageMetadataType} from '../graphs/chat/chat-metadata.type';
import {ChatRepository} from '../repositories';
import {mergeAttachments} from '../utils';

const debug = require('debug')('ai-integration:scripts:backfill-mastra-memory');

type ScriptOptions = {
  appModule: string;
  appExport?: string;
  dryRun: boolean;
  pageSize: number;
  limit?: number;
  chatId?: string;
};

type LegacyChat = {
  id: string;
  title?: string;
  tenantId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  createdOn?: unknown;
  modifiedOn?: unknown;
};

type LegacyMessage = {
  id?: string;
  body?: string;
  metadata?: Record<string, unknown>;
  parentMessageId?: string;
  createdOn?: unknown;
  modifiedOn?: unknown;
};

type MemoryStoreLike = {
  getThreadById(args: {
    threadId: string;
    resourceId?: string;
  }): Promise<StorageThreadType | null>;
  saveThread(args: {thread: StorageThreadType}): Promise<StorageThreadType>;
  listMessages(args: {
    threadId: string | string[];
    resourceId?: string;
    page?: number;
    perPage?: number | false;
  }): Promise<{messages: MastraDBMessage[]}>;
  saveMessages(args: {
    messages: MastraDBMessage[];
  }): Promise<{messages: MastraDBMessage[]}>;
  getResourceById?(args: {resourceId: string}): Promise<unknown>;
  saveResource?(args: {
    resource: {
      id: string;
      metadata?: Record<string, unknown>;
      createdAt: Date;
      updatedAt: Date;
    };
  }): Promise<unknown>;
};

type Stats = {
  chatsScanned: number;
  chatsMigrated: number;
  chatsSkippedExisting: number;
  chatsFailed: number;
  threadsCreated: number;
  messagesMigrated: number;
  attachmentsMerged: number;
};

function parseOptions(argv: string[]): ScriptOptions {
  const flag = (name: string): string | undefined => {
    const prefixed = argv.find(v => v.startsWith(`${name}=`));
    if (prefixed) {
      return prefixed.slice(name.length + 1);
    }

    const index = argv.indexOf(name);
    if (index >= 0 && argv[index + 1]) {
      return argv[index + 1];
    }

    return undefined;
  };

  const dryRun = argv.includes('--dry-run');
  const appModule =
    flag('--app-module') ?? process.env.APP_MODULE ?? './dist/application';
  const appExport = flag('--app-export') ?? process.env.APP_EXPORT;

  const pageSizeRaw =
    flag('--page-size') ?? process.env.BACKFILL_PAGE_SIZE ?? '100';
  const pageSize = Number(pageSizeRaw);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new Error(`Invalid page size: ${pageSizeRaw}`);
  }

  const limitRaw = flag('--limit') ?? process.env.BACKFILL_LIMIT;
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`Invalid limit: ${limitRaw}`);
  }

  const chatId = flag('--chat-id') ?? process.env.BACKFILL_CHAT_ID;

  return {
    appModule,
    appExport,
    dryRun,
    pageSize,
    limit,
    chatId,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function toDate(value: unknown, fallback: Date = new Date()): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return fallback;
}

function resolveResourceId(chat: LegacyChat): string {
  if (chat.tenantId && chat.userId) {
    return `${chat.tenantId}:${chat.userId}`;
  }

  if (chat.userId) {
    return chat.userId;
  }

  return chat.id;
}

function getMetadataType(message: LegacyMessage): string | undefined {
  const metadata = asRecord(message.metadata);
  return asString(metadata.type)?.toLowerCase();
}

function mapMessageRole(message: LegacyMessage): MastraDBMessage['role'] {
  const metadataType = getMetadataType(message);

  switch (metadataType) {
    case MessageMetadataType.User:
    case MessageMetadataType.Attachment:
      return 'user';
    case MessageMetadataType.System:
      return 'system';
    default:
      return 'assistant';
  }
}

function getMessageBody(message: LegacyMessage): string {
  const body = typeof message.body === 'string' ? message.body : '';
  if (body.trim()) {
    return body;
  }

  const metadata = asRecord(message.metadata);
  const summary = asString(metadata.summary);
  if (summary) {
    return summary;
  }

  return ' ';
}

function normalizeRootMessages(messages: LegacyMessage[]): {
  roots: LegacyMessage[];
  childrenByParentId: Map<string, LegacyMessage[]>;
} {
  const childrenByParentId = new Map<string, LegacyMessage[]>();
  const roots: LegacyMessage[] = [];

  for (const message of messages) {
    const parentId = asString(message.parentMessageId);
    if (!parentId) {
      roots.push(message);
      continue;
    }

    const children = childrenByParentId.get(parentId) ?? [];
    children.push(message);
    childrenByParentId.set(parentId, children);
  }

  const sortByTime = (a: LegacyMessage, b: LegacyMessage) => {
    const left = toDate(a.createdOn).getTime();
    const right = toDate(b.createdOn).getTime();
    if (left === right) {
      const leftId = a.id ?? '';
      const rightId = b.id ?? '';
      return leftId.localeCompare(rightId);
    }

    return left - right;
  };

  roots.sort(sortByTime);
  for (const children of childrenByParentId.values()) {
    children.sort(sortByTime);
  }

  return {roots, childrenByParentId};
}

function appendAttachmentSummaries(
  messageText: string,
  children: LegacyMessage[],
): {text: string; mergedCount: number} {
  let text = messageText;
  let mergedCount = 0;

  for (const child of children) {
    const metadataType = getMetadataType(child);
    if (metadataType !== MessageMetadataType.Attachment) {
      continue;
    }

    const metadata = asRecord(child.metadata);
    const fileName = asString(metadata.fileName) ?? 'attachment';
    const summary = asString(metadata.summary) ?? getMessageBody(child);
    text = mergeAttachments(text, fileName, summary);
    mergedCount += 1;
  }

  return {text, mergedCount};
}

function appendToolSummaries(
  messageText: string,
  children: LegacyMessage[],
): string {
  const toolLines: string[] = [];

  for (const child of children) {
    const metadataType = getMetadataType(child);
    if (metadataType !== MessageMetadataType.Tool) {
      continue;
    }

    const metadata = asRecord(child.metadata);
    const toolName = asString(metadata.toolName) ?? 'tool';
    const toolCallId = asString(metadata.id) ?? child.id ?? randomUUID();
    const body = getMessageBody(child).trim();
    toolLines.push(
      body
        ? `[tool:${toolName} id=${toolCallId}] ${body}`
        : `[tool:${toolName} id=${toolCallId}] completed`,
    );
  }

  if (!toolLines.length) {
    return messageText;
  }

  return `${messageText}\n\nTool activity:\n${toolLines.join('\n')}`;
}

function toMastraMessage(
  chat: LegacyChat,
  resourceId: string,
  message: LegacyMessage,
  children: LegacyMessage[],
): {message: MastraDBMessage; mergedAttachments: number} {
  const metadata = asRecord(message.metadata);
  const messageId = message.id ?? randomUUID();

  let text = getMessageBody(message);
  let mergedAttachments = 0;

  if (getMetadataType(message) === MessageMetadataType.User) {
    const merged = appendAttachmentSummaries(text, children);
    text = merged.text;
    mergedAttachments = merged.mergedCount;
  }

  if (getMetadataType(message) === MessageMetadataType.AI) {
    text = appendToolSummaries(text, children);
  }

  const contentMetadata: Record<string, unknown> = {
    ...metadata,
    legacy: {
      chatId: chat.id,
      messageId,
      mergedAttachmentCount: mergedAttachments,
    },
  };

  const mastraMessage: MastraDBMessage = {
    id: messageId,
    role: mapMessageRole(message),
    type: 'text',
    createdAt: toDate(message.createdOn),
    threadId: chat.id,
    resourceId,
    content: {
      format: 2,
      parts: [{type: 'text', text}],
      metadata: contentMetadata,
    } as MastraDBMessage['content'],
  };

  return {message: mastraMessage, mergedAttachments};
}

function isMemoryStoreLike(value: unknown): value is MemoryStoreLike {
  const candidate = value as Partial<MemoryStoreLike> | undefined;
  return !!(
    candidate &&
    typeof candidate.getThreadById === 'function' &&
    typeof candidate.saveThread === 'function' &&
    typeof candidate.listMessages === 'function' &&
    typeof candidate.saveMessages === 'function'
  );
}

async function resolveMemoryStore(storage: unknown): Promise<MemoryStoreLike> {
  if (isMemoryStoreLike(storage)) {
    return storage;
  }

  if (
    storage instanceof MastraCompositeStore ||
    (typeof storage === 'object' &&
      storage !== null &&
      typeof (storage as {getStore?: unknown}).getStore === 'function')
  ) {
    const composite = storage as {
      getStore: (domain: string) => Promise<unknown>;
    };
    const memory = await composite.getStore('memory');
    if (isMemoryStoreLike(memory)) {
      return memory;
    }
  }

  throw new Error(
    'Could not resolve a memory storage domain from AiIntegrationBindings.MastraStorage.',
  );
}

function resolveAppClass(
  moduleExports: Record<string, unknown>,
  requestedExport?: string,
): new () => Application {
  const candidates: unknown[] = [];

  if (requestedExport) {
    candidates.push(moduleExports[requestedExport]);
  }

  candidates.push(
    moduleExports.default,
    moduleExports.Application,
    ...Object.values(moduleExports),
  );

  for (const candidate of candidates) {
    if (typeof candidate !== 'function') {
      continue;
    }

    const ctor = candidate as new () => Application;
    const prototype = (ctor as unknown as {prototype?: Record<string, unknown>})
      .prototype;

    if (prototype && typeof prototype.start === 'function') {
      return ctor;
    }
  }

  throw new Error(
    `Failed to resolve LoopBack application class. Export requested: ${requestedExport ?? 'default'}`,
  );
}

async function loadApplication(options: ScriptOptions): Promise<Application> {
  const modulePath = path.isAbsolute(options.appModule)
    ? options.appModule
    : path.resolve(process.cwd(), options.appModule);

  debug(`Loading application module from ${modulePath}`);

  const moduleExports = require(modulePath) as Record<string, unknown>;
  const AppClass = resolveAppClass(moduleExports, options.appExport);

  const app = new AppClass();

  const bootableApp = app as Application & {boot?: () => Promise<void>};
  if (typeof bootableApp.boot === 'function') {
    await bootableApp.boot();
  }

  await app.start();
  return app;
}

async function ensureResource(
  memoryStore: MemoryStoreLike,
  resourceId: string,
  chat: LegacyChat,
): Promise<void> {
  if (!memoryStore.getResourceById || !memoryStore.saveResource) {
    return;
  }

  const existing = await memoryStore.getResourceById({resourceId});
  if (existing) {
    return;
  }

  const createdAt = toDate(chat.createdOn);
  const updatedAt = toDate(chat.modifiedOn, createdAt);

  await memoryStore.saveResource({
    resource: {
      id: resourceId,
      metadata: {
        tenantId: chat.tenantId,
        userId: chat.userId,
        migratedFrom: 'legacy-chat-store',
      },
      createdAt,
      updatedAt,
    },
  });
}

async function migrateSingleChat(
  chatRepository: ChatRepository,
  memoryStore: MemoryStoreLike,
  chat: LegacyChat,
  dryRun: boolean,
  stats: Stats,
): Promise<void> {
  const resourceId = resolveResourceId(chat);
  const existingThread = await memoryStore.getThreadById({
    threadId: chat.id,
    resourceId,
  });

  if (existingThread) {
    const existingMessages = await memoryStore.listMessages({
      threadId: chat.id,
      resourceId,
      page: 0,
      perPage: 1,
    });

    if ((existingMessages.messages?.length ?? 0) > 0) {
      stats.chatsSkippedExisting += 1;
      return;
    }
  }

  const legacyMessagesRaw = await chatRepository.messages(chat.id).find({
    order: ['createdOn ASC', 'id ASC'],
  });
  const legacyMessages = legacyMessagesRaw.map(
    message => message as LegacyMessage,
  );

  const {roots, childrenByParentId} = normalizeRootMessages(legacyMessages);

  if (dryRun) {
    stats.chatsMigrated += 1;
    stats.messagesMigrated += roots.length;
    return;
  }

  await ensureResource(memoryStore, resourceId, chat);

  if (!existingThread) {
    const threadCreatedAt = toDate(chat.createdOn);
    const threadUpdatedAt = toDate(chat.modifiedOn, threadCreatedAt);

    await memoryStore.saveThread({
      thread: {
        id: chat.id,
        title: chat.title,
        resourceId,
        createdAt: threadCreatedAt,
        updatedAt: threadUpdatedAt,
        metadata: {
          ...(chat.metadata ?? {}),
          tenantId: chat.tenantId,
          userId: chat.userId,
          migratedFrom: 'legacy-chat-store',
          legacyChatId: chat.id,
        },
      },
    });

    stats.threadsCreated += 1;
  }

  const messagesToPersist: MastraDBMessage[] = [];
  for (const root of roots) {
    const rootId = asString(root.id);
    const children = rootId ? (childrenByParentId.get(rootId) ?? []) : [];
    const migrated = toMastraMessage(chat, resourceId, root, children);
    messagesToPersist.push(migrated.message);
    stats.attachmentsMerged += migrated.mergedAttachments;
  }

  const batchSize = 200;
  for (let i = 0; i < messagesToPersist.length; i += batchSize) {
    await memoryStore.saveMessages({
      messages: messagesToPersist.slice(i, i + batchSize),
    });
  }

  stats.chatsMigrated += 1;
  stats.messagesMigrated += messagesToPersist.length;
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const stats: Stats = {
    chatsScanned: 0,
    chatsMigrated: 0,
    chatsSkippedExisting: 0,
    chatsFailed: 0,
    threadsCreated: 0,
    messagesMigrated: 0,
    attachmentsMerged: 0,
  };

  let app: Application | undefined;

  try {
    app = await loadApplication(options);

    const chatRepository = await app.get<ChatRepository>(
      'repositories.ChatRepository',
    );
    const storage = await app.get<unknown>(AiIntegrationBindings.MastraStorage);
    const memoryStore = await resolveMemoryStore(storage);

    if (options.chatId) {
      const chat = (await chatRepository.findById(
        options.chatId,
      )) as LegacyChat;
      stats.chatsScanned = 1;
      await migrateSingleChat(
        chatRepository,
        memoryStore,
        chat,
        options.dryRun,
        stats,
      );
    } else {
      let skip = 0;
      let scanned = 0;

      for (; options.limit === undefined || scanned < options.limit; ) {
        const remaining =
          options.limit !== undefined
            ? options.limit - scanned
            : options.pageSize;
        if (remaining <= 0) {
          break;
        }

        const currentLimit =
          options.limit !== undefined
            ? Math.min(options.pageSize, remaining)
            : options.pageSize;

        const chats = (await chatRepository.find({
          limit: currentLimit,
          skip,
          order: ['createdOn ASC'],
        })) as LegacyChat[];

        if (!chats.length) {
          break;
        }

        for (const chat of chats) {
          stats.chatsScanned += 1;
          scanned += 1;

          try {
            await migrateSingleChat(
              chatRepository,
              memoryStore,
              chat,
              options.dryRun,
              stats,
            );
          } catch (error) {
            stats.chatsFailed += 1;
            const message =
              error instanceof Error ? error.message : String(error);
            console.error(`Failed to migrate chat ${chat.id}: ${message}`);
          }
        }

        skip += chats.length;
      }
    }

    const mode = options.dryRun ? 'DRY RUN' : 'EXECUTION';
    console.log(`[Mastra Backfill] ${mode} complete.`);
    console.log(
      JSON.stringify(
        {
          appModule: options.appModule,
          appExport: options.appExport ?? 'default',
          dryRun: options.dryRun,
          ...stats,
        },
        null,
        2,
      ),
    );
  } finally {
    if (app) {
      await app.stop();
    }
  }
}

run().catch(error => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[Mastra Backfill] failed:', message);
  process.exitCode = 1;
});

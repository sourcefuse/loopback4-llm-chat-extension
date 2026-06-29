#!/usr/bin/env node
/**
 * Forward-only, idempotent backfill of the legacy `chats` / `messages`
 * tables into the Mastra storage adapter bound at
 * `InternalBindings.Storage`.
 *
 * Usage from a consumer app:
 * APP_MODULE=./dist/application npx backfill-mastra-threads --dry-run
 * APP_MODULE=./dist/application npx backfill-mastra-threads
 *
 * The script boots the consumer's LB4 Application so it inherits the
 * exact ChatRepository / MessageRepository / MastraStorage bindings the
 * runtime uses — no separate datasource wiring required.
 *
 * Idempotency: each chat is skipped if a Mastra thread with the same id
 * already exists. Re-running the script is safe.
 *
 * Refs: the migration plan.
 */
import type {Application as CoreApplication} from '@loopback/core';
import {InternalBindings} from '../runtime/internal-bindings';
import {Chat} from '../models/chat.model';
import {Message} from '../models/message.model';
import {MessageMetadataType} from '../graphs/message-metadata.type';
import type {ChatRepository} from '../repositories/chat.repository';
import type {MessageRepository} from '../repositories/message.repository';

/**
 * Consumer's Application is expected to mix in BootMixin + RepositoryMixin
 * (the standard LB4 app shape). Those add `.boot()` and `.getRepository()`
 * which are not on the base `Application` type — hence the union below.
 */
type BootableApplication = CoreApplication & {
  boot(): Promise<void>;
  getRepository<T>(name: string): Promise<T>;
  stop(): Promise<void>;
};

type MastraMessageRole = 'user' | 'assistant' | 'tool' | 'system';

interface BackfillSummary {
  seen: number;
  created: number;
  skipped: number;
  messagesWritten: number;
  errors: Array<{chatId: string; error: string}>;
}

const PROGRESS_EVERY = 100;
const DRY_RUN = process.argv.includes('--dry-run');

// This is a standalone CLI tool — progress/summary go straight to the operator's
// terminal. Write via process.stdout/stderr rather than `console.*` (the latter
// trips SonarQube S106 / no-console, meant for library code, not scripts).
const out = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};
const errOut = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

/**
 * Tenant-scoped resourceId — MUST match the format the runtime
 * resource identity format `${tenantId}:${userId}` used by runtime, otherwise
 * threads end up orphaned (DB rows exist but no live request hits
 * them at Memory.scope='resource').
 *
 * Default mirrors the recommended single-tenant-safe format from
 *. Override via the BACKFILL_RESOURCE_ID_FORMAT env var:
 * - 'tenant-user' (default): `${tenantId}:${userId}` with userId fallback
 * - 'user-only': bare `userId`, single-tenant only
 */
function formatResourceId(chat: Chat): string {
  const mode = process.env.BACKFILL_RESOURCE_ID_FORMAT ?? 'tenant-user';
  if (mode === 'user-only') return chat.userId;
  if (chat.tenantId) return `${chat.tenantId}:${chat.userId}`;
  return chat.userId;
}

function mastraRoleFor(message: Message): MastraMessageRole {
  const metaType = (message.metadata as {type?: MessageMetadataType})?.type;
  switch (metaType) {
    case MessageMetadataType.AI:
      return 'assistant';
    case MessageMetadataType.Tool:
      return 'tool';
    case MessageMetadataType.System:
      return 'system';
    case MessageMetadataType.Attachment:
    case MessageMetadataType.User:
    default:
      return 'user';
  }
}

async function loadConsumerApp(): Promise<BootableApplication> {
  const modulePath = process.env.APP_MODULE;
  if (!modulePath) {
    throw new Error(
      'APP_MODULE env var required. Point it at your built Application module (e.g. ./dist/application).',
    );
  }
  // Use Node's require so CommonJS exports resolve naturally from the
  // consumer's compiled output. Both `default` and named exports are
  // supported (TS class exports compile to either depending on config).
  const mod = require(modulePath);
  const Ctor =
    mod.default ?? mod.Application ?? mod.MyApp ?? Object.values(mod)[0];
  if (typeof Ctor !== 'function') {
    throw new TypeError(
      `Could not locate an Application constructor in ${modulePath}. Export it as default, Application, or MyApp.`,
    );
  }
  const app = new Ctor() as BootableApplication;
  await app.boot();
  return app;
}

/**
 * Mastra Memory shape used by the backfill: a Map-style getter on
 * threadId plus createThread + saveMessages. Hand-rolled to avoid
 * pulling the heavy @mastra/memory type into a CLI script and to keep
 * the function helpers testable.
 */
type MemoryLike = {
  getThreadById(args: {threadId: string}): Promise<unknown>;
  createThread(args: {
    threadId: string;
    resourceId: string;
    title?: string;
    metadata?: unknown;
  }): Promise<unknown>;
  saveMessages(args: {messages: unknown[]}): Promise<unknown>;
  // Optional: used only to detect a partially-backfilled thread (created by a
  // prior run that died before saveMessages) so it can be repaired instead of
  // skipped forever. Absent on older Memory versions — see countSavedMessages.
  query?(args: {threadId: string}): Promise<{messages?: unknown[]} | undefined>;
};

/**
 * Number of messages already persisted on a thread. Returns 0 when the Memory
 * implementation exposes no `query` (older versions): callers then fall back
 * to re-saving, which is safe because message payloads carry the stable source
 * id (`buildMessagePayloads`) so `saveMessages` upserts rather than duplicates.
 */
async function countSavedMessages(
  memory: MemoryLike,
  threadId: string,
): Promise<number> {
  if (!memory.query) return 0;
  try {
    const res = await memory.query({threadId});
    return Array.isArray(res?.messages) ? res.messages.length : 0;
  } catch {
    return 0;
  }
}

async function resolveMemory(app: BootableApplication): Promise<MemoryLike> {
  const mastra = (await app.get(
    InternalBindings.Mastra,
  )) as import('@mastra/core').Mastra;
  const memory = await mastra.getAgent('chatAgent')?.getMemory();
  if (!memory) {
    throw new Error(
      'Mastra Memory not configured on chatAgent. Verify internal Mastra storage binding is available.',
    );
  }
  return memory as unknown as MemoryLike;
}

function buildMessagePayloads(
  chat: Chat,
  msgs: Message[],
  resourceId: string,
): unknown[] {
  return msgs.map(m => ({
    id: m.id,
    threadId: chat.id,
    resourceId,
    role: mastraRoleFor(m),
    content: m.body,
    createdAt: m.createdOn,
    metadata: {
      sourceloopAudit: {
        createdBy: m.createdBy,
        createdOn: m.createdOn,
        modifiedBy: m.modifiedBy,
        modifiedOn: m.modifiedOn,
        deleted: m.deleted,
        deletedOn: m.deletedOn,
        deletedBy: m.deletedBy,
      },
      tenantId: chat.tenantId,
      original: m.metadata,
    },
  }));
}

async function backfillChat(
  chat: Chat,
  memory: MemoryLike,
  msgs: Message[],
  summary: BackfillSummary,
): Promise<void> {
  const resourceId = formatResourceId(chat);
  const existing = await memory.getThreadById({threadId: chat.id});
  // Idempotency + crash-repair. createThread and saveMessages are two separate
  // non-transactional awaits, so a run that died between them leaves a thread
  // with zero (or partial) messages. Skipping purely on thread existence would
  // strand that thread empty forever. Skip only when the thread already exists
  // AND already holds all its messages; otherwise fall through to (re)save —
  // safe because saveMessages upserts on the stable source message id.
  if (existing) {
    const saved = await countSavedMessages(memory, chat.id);
    if (msgs.length === 0 || saved >= msgs.length) {
      summary.skipped++;
      return;
    }
  }
  if (DRY_RUN) {
    const verb = existing ? 'repair (re-save messages for)' : 'create';
    out(
      `[dry-run] would ${verb} thread ${chat.id} resourceId=${resourceId} (${msgs.length} messages)`,
    );
    summary.created++;
    summary.messagesWritten += msgs.length;
    return;
  }
  if (!existing) {
    await memory.createThread({
      threadId: chat.id,
      resourceId,
      title: chat.title ?? undefined,
      metadata: chat.metadata ?? undefined,
    });
  }
  if (msgs.length) {
    // Memory.saveMessages accepts both the modern MastraDBMessage and
    // the legacy MastraMessageV1 shape; it normalises content
    // internally. We emit the V1 string-content shape and cast through
    // `never` to silence the V2 schema requirement — verify the exact
    // shape against your installed @mastra/memory version if you
    // observe mismatches.
    await memory.saveMessages({
      messages: buildMessagePayloads(chat, msgs, resourceId) as never,
    });
  }
  summary.created++;
  summary.messagesWritten += msgs.length;
}

async function backfill(): Promise<void> {
  const app = await loadConsumerApp();
  const memory = await resolveMemory(app);
  const chatRepo = await app.getRepository<ChatRepository>(
    'repositories.ChatRepository',
  );
  const msgRepo = await app.getRepository<MessageRepository>(
    'repositories.MessageRepository',
  );
  const chats = await chatRepo.find();
  // Batch-fetch all messages in a single query instead of N per-chat
  // round-trips. Group by channelId so each backfillChat call gets its
  // slice without touching the DB again.
  const chatIds = chats.map(c => c.id).filter(Boolean) as string[];
  const allMsgs = chatIds.length
    ? await msgRepo.find({
        where: {channelId: {inq: chatIds}},
        order: ['createdOn ASC'],
      })
    : [];
  const msgsByChat = new Map<string, Message[]>();
  for (const m of allMsgs) {
    if (!m.channelId) continue;
    const arr = msgsByChat.get(m.channelId) ?? [];
    arr.push(m);
    msgsByChat.set(m.channelId, arr);
  }
  const summary: BackfillSummary = {
    seen: 0,
    created: 0,
    skipped: 0,
    messagesWritten: 0,
    errors: [],
  };
  for (const chat of chats) {
    summary.seen++;
    const msgs = msgsByChat.get(chat.id) ?? [];
    try {
      await backfillChat(chat, memory, msgs, summary);
    } catch (err) {
      summary.errors.push({chatId: chat.id, error: (err as Error).message});
      errOut(`[error] chat ${chat.id}: ${(err as Error).message}`);
    }
    if (summary.seen % PROGRESS_EVERY === 0) {
      out(
        `[progress] ${summary.seen}/${chats.length} seen | ${summary.created} created | ${summary.skipped} skipped | ${summary.errors.length} errors`,
      );
    }
  }
  out('\n=== Backfill Summary ===');
  out(JSON.stringify(summary, null, 2));
  await app.stop();
  if (summary.errors.length > 0) process.exit(1);
}

backfill().catch(err => {
  errOut(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

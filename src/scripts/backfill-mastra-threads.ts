#!/usr/bin/env node
/**
 * Forward-only, idempotent backfill of the legacy `chats` / `messages`
 * tables into the Mastra storage adapter bound at
 * `AiIntegrationBindings.MastraStorage`.
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
import {AiIntegrationBindings} from '../keys';
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

/**
 * Tenant-scoped resourceId — MUST match the format the runtime
 * `AiIntegrationBindings.ResourceId` resolver returns, otherwise
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
    throw new Error(
      `Could not locate an Application constructor in ${modulePath}. Export it as default, Application, or MyApp.`,
    );
  }
  const app = new Ctor() as BootableApplication;
  await app.boot();
  return app;
}

async function backfill(): Promise<void> {
  const app = await loadConsumerApp();
  const mastra = await app.get(AiIntegrationBindings.Mastra);
  const memory = await mastra.getAgent('chatAgent')?.getMemory();
  if (!memory) {
    throw new Error(
      'Mastra Memory not configured on chatAgent. Verify AiIntegrationBindings.MastraStorage is bound.',
    );
  }

  const chatRepo = await app.getRepository<ChatRepository>(
    'repositories.ChatRepository',
  );
  const msgRepo = await app.getRepository<MessageRepository>(
    'repositories.MessageRepository',
  );

  const chats = await chatRepo.find();
  const summary: BackfillSummary = {
    seen: 0,
    created: 0,
    skipped: 0,
    messagesWritten: 0,
    errors: [],
  };

  for (const chat of chats) {
    summary.seen++;
    try {
      const resourceId = formatResourceId(chat);
      const existing = await memory.getThreadById({threadId: chat.id});
      if (existing) {
        summary.skipped++;
        continue;
      }

      const msgs = await msgRepo.find({
        where: {channelId: chat.id},
        order: ['createdOn ASC'],
      });

      if (DRY_RUN) {
        console.log(
          `[dry-run] would create thread ${chat.id} resourceId=${resourceId} (${msgs.length} messages)`,
        );
        summary.created++;
        summary.messagesWritten += msgs.length;
        continue;
      }

      await memory.createThread({
        threadId: chat.id,
        resourceId,
        title: chat.title ?? undefined,
        metadata: chat.metadata ?? undefined,
      });

      if (msgs.length) {
        // Memory.saveMessages accepts both the modern MastraDBMessage and
        // the legacy MastraMessageV1 shape; it normalises content
        // internally. We emit the V1 string-content shape and cast through
        // `never` to silence the V2 schema requirement — verify the exact
        // shape against your installed @mastra/memory version if you
        // observe mismatches.
        await memory.saveMessages({
          messages: msgs.map(m => ({
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
          })) as never,
        });
      }

      summary.created++;
      summary.messagesWritten += msgs.length;
    } catch (err) {
      summary.errors.push({
        chatId: chat.id,
        error: (err as Error).message,
      });
      console.error(`[error] chat ${chat.id}:`, (err as Error).message);
    }

    if (summary.seen % PROGRESS_EVERY === 0) {
      console.log(
        `[progress] ${summary.seen}/${chats.length} seen | ${summary.created} created | ${summary.skipped} skipped | ${summary.errors.length} errors`,
      );
    }
  }

  console.log('\n=== Backfill Summary ===');
  console.log(JSON.stringify(summary, null, 2));
  await app.stop();

  if (summary.errors.length > 0) process.exit(1);
}

backfill().catch(err => {
  console.error(err);
  process.exit(1);
});

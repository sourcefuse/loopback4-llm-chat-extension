import {inject, injectable, BindingScope} from '@loopback/core';
import type {ChatRepository} from '../repositories';

export interface ChatLedgerRow {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
}

/**
 * Injectable successor of v2's `ChatStore` token bookkeeping. Upserts the
 * per-session token-usage row the three token/chat limit strategies read.
 *
 * v2's ChatStore created a `chats` row per session and `updateCounts`
 * incremented input/output tokens on it; the strategies sum that table to
 * enforce caps. The Mastra runtime stores usage on Memory thread metadata, so
 * without this the `chats` table stays empty and the caps silently never fire.
 * This restores the ledger write (keyed by threadId to line up with the Memory
 * thread) alongside the metadata write.
 *
 * Bound as a service so a consumer can rebind it to override accounting.
 * ChatRepository is optional: a consumer without the `chats` table simply gets
 * a no-op (best-effort — an accounting write must never break the reply).
 */
@injectable({scope: BindingScope.TRANSIENT})
export class ChatLedgerService {
  constructor(
    @inject('repositories.ChatRepository', {optional: true})
    private readonly repo?: ChatRepository,
  ) {}

  async upsert(
    row: ChatLedgerRow,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    if (!this.repo) return;
    const [existing] = await this.repo
      .find({where: {id: row.id}})
      .catch(() => [] as Array<{inputTokens: number; outputTokens: number}>);
    if (existing) {
      await this.repo
        .updateById(row.id, {
          // Guard NULL/undefined columns: a Chat row inserted by any path that
          // omits the token columns yields NaN here, which the limit strategies
          // would then read. Mirrors the thread-metadata path in the runner.
          inputTokens: (Number(existing.inputTokens) || 0) + inputTokens,
          outputTokens: (Number(existing.outputTokens) || 0) + outputTokens,
        })
        .catch(() => undefined);
      return;
    }
    await this.repo
      .create({
        id: row.id,
        tenantId: row.tenantId,
        userId: row.userId,
        title: row.title,
        inputTokens,
        outputTokens,
        metadata: {},
      } as never)
      .catch(() => undefined);
  }
}

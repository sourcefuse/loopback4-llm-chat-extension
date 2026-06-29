import type {ChatRepository} from '../repositories';

/** The subset of ChatRepository the ledger needs (keeps it unit-testable). */
export type ChatLedgerRepo = Pick<
  ChatRepository,
  'find' | 'updateById' | 'create'
>;

export interface ChatLedgerRow {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
}

/**
 * Upsert the per-session token-usage row the limit strategies read.
 *
 * v2's ChatStore created a `chats` row per session and `updateCounts`
 * incremented input/output tokens on it; the three token/chat limit strategies
 * sum that table to enforce caps. The Mastra runtime stores usage on Memory
 * thread metadata instead, so without this the `chats` table stays empty and
 * the caps silently never fire. This restores the ledger write (keyed by
 * threadId so it lines up with the Memory thread) alongside the metadata write.
 *
 * Best-effort: an accounting write must never break the user's reply.
 */
export async function upsertChatTokenLedger(
  repo: ChatLedgerRepo,
  row: ChatLedgerRow,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const [existing] = await repo
    .find({where: {id: row.id}})
    .catch(() => [] as Array<{inputTokens: number; outputTokens: number}>);
  if (existing) {
    await repo
      .updateById(row.id, {
        // Guard NULL/undefined columns: a Chat row inserted by any path that
        // omits the token columns yields NaN here, which the limit strategies
        // would then read. Mirrors the thread-metadata path in workflow-runner.
        inputTokens: (Number(existing.inputTokens) || 0) + inputTokens,
        outputTokens: (Number(existing.outputTokens) || 0) + outputTokens,
      })
      .catch(() => undefined);
    return;
  }
  await repo
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

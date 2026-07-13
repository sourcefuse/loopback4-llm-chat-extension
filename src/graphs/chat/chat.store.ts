import {randomUUID} from 'node:crypto';
import debugFactory from 'debug';
import {
  BindingScope,
  Context,
  inject,
  injectable,
  service,
} from '@loopback/core';
import {Mastra} from '@mastra/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {AiIntegrationBindings} from '../../keys';
import {CHAT_TITLE_MAX_LENGTH} from '../../constant';
import {ChatLedgerService} from '../../services/chat-ledger.service';
import {
  deriveResourceId,
  resolvePrincipalId,
} from '../../runtime/resource-id.util';
import type {ResolvedThread, ThreadMemory} from '../state';

const debug = debugFactory('ai-integration:chat:store');

/**
 * Persistence + identity for the chat graph — the Mastra-backed successor of
 * the LangGraph `ChatStore`. The LangGraph store read/wrote the ARC
 * `chats`/`messages` tables; here conversation history lives in Mastra Memory
 * (threads), so this store (a) resolves the Memory adapter off the registered
 * chatAgent, (b) resolves/creates the thread for a run and enforces
 * tenant-scoped ownership on resume, and (c) persists cumulative token counts to
 * BOTH the thread metadata (so `/chats` counts are meaningful) and the `chats`
 * ledger row (what the token/chat limit strategies read).
 *
 * REQUEST-scoped like the LangGraph original so it can read the authenticated
 * user off the request context. Injected into the chat nodes via `@service`.
 */
@injectable({scope: BindingScope.REQUEST})
export class ChatStore {
  constructor(
    @inject.context() protected readonly lb4Ctx: Context,
    @inject(AiIntegrationBindings.Mastra) protected readonly mastra: Mastra,
    @inject(AiIntegrationBindings.ResourceId, {optional: true})
    protected readonly resourceIdValue?: string,
    @service(ChatLedgerService, {optional: true})
    protected readonly chatLedger?: ChatLedgerService,
  ) {}

  /** The Mastra Memory adapter off the registered chatAgent, or undefined. */
  protected async memory(): Promise<ThreadMemory | undefined> {
    const agent = this.mastra.getAgent('chatAgent');
    const mem = await agent?.getMemory();
    return (mem as unknown as ThreadMemory | undefined) ?? undefined;
  }

  /**
   * Tenant-scoped requester identity used to stamp new threads and authorize
   * resume of existing ones. Prefers an explicitly bound
   * `AiIntegrationBindings.ResourceId`; otherwise derives `${tenantId}:${id}`
   * from the authenticated user. Returns undefined when neither is resolvable
   * so callers refuse rather than resume into the wrong scope.
   */
  async resolveRequesterResourceId(): Promise<string | undefined> {
    const user = await this.lb4Ctx.get<IAuthUserWithPermissions>(
      AuthenticationBindings.CURRENT_USER,
      {optional: true},
    );
    return deriveResourceId(user, this.resourceIdValue);
  }

  /**
   * Resolve the Memory thread for this run (the LangGraph `ChatStore.init`
   * successor). On a fresh request (no sessionId) creates a thread stamped with
   * the requester identity + a prompt-derived title and emits Init. On resume,
   * loads the thread and enforces: it exists, carries a resourceId, the
   * requester identity is resolvable, and it matches the thread's owner.
   * Returns {error} for any failure (incl. Memory not configured) so the caller
   * stays flat.
   */
  async resolveThread(
    sessionId: string | undefined,
    requesterResourceId: string | undefined,
    emitInit: (sessionId: string) => void,
    prompt?: string,
  ): Promise<ResolvedThread> {
    const memory = await this.memory();
    if (!memory) {
      return {error: 'Mastra Memory is required but not configured'};
    }
    if (!sessionId) {
      return this.createNewThread(
        memory,
        requesterResourceId,
        emitInit,
        prompt,
      );
    }
    return this.resumeThread(memory, sessionId, requesterResourceId);
  }

  /**
   * Fresh-request path: create a thread stamped with the requester identity +
   * a prompt-derived title and emit Init. Extracted from `resolveThread` to
   * keep it under the complexity cap (S1541).
   */
  protected async createNewThread(
    memory: ThreadMemory,
    requesterResourceId: string | undefined,
    emitInit: (sessionId: string) => void,
    prompt?: string,
  ): Promise<ResolvedThread> {
    const resourceId = requesterResourceId ?? randomUUID();
    // Title from the first prompt (truncated), mirroring LangGraph main's
    // ChatStore.init (`prompt.slice(0, 200)`). Without it threads have no
    // title and the chat-history list shows blanks — Mastra only auto-titles
    // when MASTRA_GENERATE_TITLE is on (an extra LLM call). Prompt-derived is
    // free and matches main's behaviour.
    const trimmed = prompt?.trim().slice(0, CHAT_TITLE_MAX_LENGTH);
    // Empty prompt → undefined title (not ''); a plain `||`/`??` either trips
    // prefer-nullish-coalescing or keeps '', so test for empty explicitly.
    const title = trimmed === '' ? undefined : trimmed;
    const thread = await memory.createThread({resourceId, title});
    emitInit(thread.id);
    return {threadId: thread.id, resourceId, title: title ?? ''};
  }

  /**
   * Resume path: load the thread and enforce it exists, carries a resourceId,
   * the requester identity is resolvable, and it matches the owner. Extracted
   * from `resolveThread` to keep it under the complexity cap (S1541).
   */
  protected async resumeThread(
    memory: ThreadMemory,
    sessionId: string,
    requesterResourceId: string | undefined,
  ): Promise<ResolvedThread> {
    const thread = await memory.getThreadById({threadId: sessionId});
    if (!thread) return {error: `Thread ${sessionId} not found`};
    // A missing resourceId is an upstream invariant violation (corruption /
    // manual DB edit). Papering over it with a fresh UUID would orphan the
    // thread's Memory scope, so refuse.
    if (!thread.resourceId) {
      return {
        error:
          `Thread ${sessionId} is missing resourceId — possible data ` +
          `corruption. Refusing to resume to avoid orphaning the conversation.`,
      };
    }
    // SECURITY: a thread may only be resumed by the same tenant-scoped
    // requester that created it. No resolvable identity → cannot prove
    // ownership → refuse rather than leak another tenant's conversation.
    if (!requesterResourceId) {
      return {
        error:
          'Unable to authorize thread resume: requester resource identity ' +
          'is unavailable. Ensure an authenticated user with tenantId + id is present, ' +
          'or bind AiIntegrationBindings.ResourceId.',
      };
    }
    if (thread.resourceId !== requesterResourceId) {
      return {
        error: `Thread ${sessionId} does not belong to the authenticated requester`,
      };
    }
    return {
      threadId: thread.id,
      resourceId: thread.resourceId,
      title: thread.title ?? '',
    };
  }

  /**
   * Persist cumulative token usage after a run (best-effort) — the LangGraph
   * `ChatStore.updateCounts` successor. TWO sinks: the Memory thread metadata
   * (so `/chats` token counts are meaningful) and the `chats` ledger row (what
   * the token/chat limit strategies read). Keyed by threadId.
   */
  async updateCounts(
    threadId: string,
    threadTitle: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    const memory = await this.memory();
    if (memory?.updateThread) {
      try {
        const current = await memory.getThreadById({threadId});
        const md = (current?.metadata as Record<string, unknown>) ?? {};
        await memory.updateThread({
          id: threadId,
          title: current?.title ?? threadTitle,
          metadata: {
            ...md,
            inputTokens: (Number(md.inputTokens) || 0) + inputTokens,
            outputTokens: (Number(md.outputTokens) || 0) + outputTokens,
          },
        });
      } catch (err) {
        debug('updateCounts (thread metadata) skipped: %o', err);
      }
    }
    await this.persistChatLedger(
      threadId,
      threadTitle,
      inputTokens,
      outputTokens,
    );
  }

  /**
   * Write the per-session token-usage row the limit strategies read (restores
   * LangGraph `ChatStore` bookkeeping). Resolves the authenticated user from the
   * request context — optional, so a consumer without the chats table simply
   * skips. Keyed by threadId; userId uses the same principal as the resourceId
   * so ownership filters line up.
   */
  protected async persistChatLedger(
    threadId: string,
    title: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    try {
      const user = await this.lb4Ctx.get<IAuthUserWithPermissions>(
        AuthenticationBindings.CURRENT_USER,
        {optional: true},
      );
      const principal = resolvePrincipalId(user);
      if (!this.chatLedger || !user?.tenantId || !principal) return;
      await this.chatLedger.upsert(
        {id: threadId, tenantId: user.tenantId, userId: principal, title},
        inputTokens,
        outputTokens,
      );
    } catch (err) {
      debug('persistChatLedger skipped: %o', err);
    }
  }
}

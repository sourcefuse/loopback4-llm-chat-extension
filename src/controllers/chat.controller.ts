import {inject} from '@loopback/core';
import {get, HttpErrors, param} from '@loopback/rest';
import {OPERATION_SECURITY_SPEC} from '@sourceloop/core';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import type {Mastra} from '@mastra/core';
import {
  authenticate,
  AuthenticationBindings,
  STRATEGY,
} from 'loopback4-authentication';
import {authorize} from 'loopback4-authorization';
import {InternalBindings} from '../runtime/internal-bindings';
import {deriveResourceId} from '../runtime/resource-id.util';
import {PermissionKey} from '../permissions';

/**
 * Read-only chat-history API, the Mastra-backed replacement for the v2
 * `ChatController` (which read the ARC `chats`/`messages` tables via
 * `ChatStore`). Chat history now lives in Mastra Memory (threads + messages in
 * the bound storage adapter), so these routes read it from there, scoped to
 * the requester's `resourceId` — the same id the `WorkflowRunner` writes
 * threads under (see {@link deriveResourceId}).
 *
 * Returns empty / 404 when Memory is not configured (no storage bound) or the
 * requester has no resolvable identity, rather than throwing.
 */
export class ChatController {
  constructor(
    @inject(InternalBindings.Mastra)
    private readonly mastra: Mastra,
    @inject(InternalBindings.ResourceId, {optional: true})
    private readonly boundResourceId?: string,
    @inject(AuthenticationBindings.CURRENT_USER, {optional: true})
    private readonly currentUser?: IAuthUserWithPermissions,
  ) {}

  private resourceId(): string | undefined {
    return deriveResourceId(this.currentUser, this.boundResourceId);
  }

  private async memory() {
    return this.mastra.getAgent('chatAgent')?.getMemory();
  }

  /** tenantId / userId for the response — from the authed user, else split out
   * of the `${tenantId}:${userId}` resourceId. */
  private identity(resourceId: string): {tenantId: string; userId: string} {
    const u = this.currentUser;
    if (u?.tenantId) {
      return {tenantId: u.tenantId, userId: u.userTenantId ?? u.id ?? ''};
    }
    const [tenantId, userId] = resourceId.split(':');
    return {tenantId: tenantId ?? '', userId: userId ?? ''};
  }

  /**
   * Map a Mastra thread to the v2 `Chat` shape the existing consumers (e.g. the
   * BizBook UI) were built against: `tenantId`/`userId`, top-level
   * `inputTokens`/`outputTokens`, `createdOn`/`modifiedOn`, `createdBy`. The
   * Mastra-native `createdAt`/`updatedAt`/`metadata` are kept too for forward
   * compatibility. Title falls back to `New Chat` (v2 main's default) so it is
   * never blank.
   */
  private toChat(
    t: {
      id: string;
      title?: string | null;
      metadata?: Record<string, unknown> | null;
      createdAt?: unknown;
      updatedAt?: unknown;
    },
    resourceId: string,
  ) {
    const {tenantId, userId} = this.identity(resourceId);
    const md = t.metadata ?? {};
    return {
      id: t.id,
      tenantId,
      userId,
      // ternary (not ??) so an empty-string title also falls back
      title: t.title ? t.title : 'New Chat',
      inputTokens: Number(md.inputTokens) || 0,
      outputTokens: Number(md.outputTokens) || 0,
      metadata: md,
      createdOn: t.createdAt,
      modifiedOn: t.updatedAt,
      createdBy: userId,
      modifiedBy: userId,
      // Mastra-native (forward compat)
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  /**
   * Flatten one Mastra message into the v2 `Message` shape(s) the existing
   * consumers (e.g. BizBook) expect. A Mastra assistant turn bundles
   * reasoning + tool-invocation + text into ONE message's `content.parts`,
   * but v2 emitted SEPARATE messages — crucially a `type:'tool'` message whose
   * metadata carries `toolName`/`args`/`existingDatasetId`, which is what the
   * UI's "Load Dataset" / re-run-from-history button reads. So expand each
   * tool-invocation part into its own `tool` message and each text part into a
   * `user`/`ai`/`system` message. Reasoning / step-start parts are dropped.
   */
  private expandMessage(
    m: Record<string, unknown>,
    threadId: string,
  ): Array<Record<string, unknown>> {
    const role = typeof m.role === 'string' ? m.role : 'user';
    const type = MSG_TYPE_BY_ROLE[role] ?? 'user';
    const baseMeta = (m.metadata as Record<string, unknown>) ?? {};
    const base = {
      channelId: threadId,
      channelType: 'chat',
      createdOn: m.createdAt ?? m.createdOn,
      role,
    };
    const mId = toMessageIdString(m.id);
    const out = chatMessageParts(m.content)
      .map((raw, i) => partToMessage(raw, base, type, baseMeta, mId, i))
      .filter((x): x is Record<string, unknown> => x !== null);
    // No structured parts (plain-string content) → one message from the text.
    if (out.length === 0) {
      out.push({
        ...base,
        id: mId,
        type,
        body: chatMessageText(m.content),
        metadata: {...baseMeta, type},
      });
    }
    return out;
  }

  @authenticate(STRATEGY.BEARER, {passReqToCallback: true})
  @authorize({permissions: [PermissionKey.ViewChat]})
  @get('/chats', {
    security: OPERATION_SECURITY_SPEC,
    responses: {'200': {description: 'List of chat threads for the user'}},
  })
  async find(
    @param.query.number('limit', {optional: true}) limit?: number,
    @param.query.number('page', {optional: true}) page?: number,
  ) {
    const resourceId = this.resourceId();
    const memory = await this.memory();
    if (!resourceId || !memory) return [];
    const result = await memory.listThreads({
      filter: {resourceId},
      perPage: limit ?? 100,
      page: page ?? 0,
      orderBy: {field: 'createdAt', direction: 'DESC'},
    });
    return result.threads.map(t => this.toChat(t, resourceId));
  }

  /**
   * Load a thread the requester owns, or throw 404. The thread carries its
   * `resourceId`; reject when it isn't the requester's (Memory is per-resource).
   */
  private async ownedThread(threadId: string, resourceId: string) {
    const memory = await this.memory();
    const thread = await memory?.getThreadById({threadId});
    if (thread?.resourceId !== resourceId) {
      throw new HttpErrors.NotFound(`Chat thread ${threadId} not found`);
    }
    return {memory: memory!, thread};
  }

  @authenticate(STRATEGY.BEARER, {passReqToCallback: true})
  @authorize({permissions: [PermissionKey.ViewChat]})
  @get('/chats/{id}', {
    security: OPERATION_SECURITY_SPEC,
    responses: {'200': {description: 'A chat thread with its message history'}},
  })
  async findById(@param.path.string('id') threadId: string) {
    const resourceId = this.resourceId();
    if (!resourceId) {
      throw new HttpErrors.NotFound(`Chat thread ${threadId} not found`);
    }
    const {memory, thread} = await this.ownedThread(threadId, resourceId);
    const result = await memory.recall({threadId});
    return {
      ...this.toChat(thread, resourceId),
      messages: result.messages.flatMap(m =>
        this.expandMessage(m as Record<string, unknown>, threadId),
      ),
    };
  }

  @authenticate(STRATEGY.BEARER, {passReqToCallback: true})
  @authorize({permissions: [PermissionKey.ViewChat]})
  @get('/chats/{id}/messages', {
    security: OPERATION_SECURITY_SPEC,
    responses: {'200': {description: 'Messages for a chat thread'}},
  })
  async messages(@param.path.string('id') threadId: string) {
    const resourceId = this.resourceId();
    if (!resourceId) {
      throw new HttpErrors.NotFound(`Chat thread ${threadId} not found`);
    }
    const {memory} = await this.ownedThread(threadId, resourceId);
    const result = await memory.recall({threadId});
    return result.messages.flatMap(m =>
      this.expandMessage(m as Record<string, unknown>, threadId),
    );
  }
}

/**
 * Extract readable text from a Mastra message `content`, which may be a string,
 * an array of typed parts ({type:'text', text}, …), or a {parts:[…]} object.
 */
/** Coerce a Memory message id (string | number | absent) to a string id. */
function toMessageIdString(id: unknown): string {
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  return '';
}

function chatMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Natural-language text only — skip reasoning / tool-invocation parts so an
    // assistant turn that only called a tool yields an empty body (as in v2).
    return content
      .map(p => {
        if (typeof p === 'string') return p;
        const part = p as {text?: unknown};
        return typeof part.text === 'string' ? part.text : '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (content && typeof content === 'object') {
    const obj = content as {text?: unknown; parts?: unknown};
    if (typeof obj.text === 'string') return obj.text;
    if (Array.isArray(obj.parts)) return chatMessageText(obj.parts);
  }
  return '';
}

const MSG_TYPE_BY_ROLE: Record<string, string> = {
  assistant: 'ai',
  tool: 'tool',
  system: 'system',
  user: 'user',
};

type ToolInvocation = {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  state?: string;
  result?: unknown;
};

/** Map one Mastra content part to a v2 message, or null to drop it
 * (reasoning / step-start / empty). Text → user/ai/system; tool-invocation →
 * a `type:'tool'` message (see toolPartToMessage). */
function partToMessage(
  raw: unknown,
  base: Record<string, unknown>,
  type: string,
  baseMeta: Record<string, unknown>,
  mId: string,
  idx: number,
): Record<string, unknown> | null {
  const p = raw as {
    type?: string;
    text?: unknown;
    toolInvocation?: ToolInvocation;
  };
  if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
    return {
      ...base,
      id: `${mId}:t${idx}`,
      type,
      body: p.text,
      metadata: {...baseMeta, type},
    };
  }
  if (p.type === 'tool-invocation' && p.toolInvocation) {
    return toolPartToMessage(p.toolInvocation, base, mId, idx);
  }
  return null;
}

/** A tool-invocation part → the v2 `type:'tool'` message carrying the metadata
 * a consumer needs to re-run a tool from history: `existingDatasetId` (Load
 * Dataset) and, for the visualization tool, `visualization` + `config` so the
 * chart can be re-rendered. The tool result is a STRING readout for the
 * dataset tools but a structured OBJECT for the visualization tool — handle
 * both (an object result was previously dropped, which is why charts didn't
 * come back when reopening a chat). */
function toolPartToMessage(
  ti: ToolInvocation,
  base: Record<string, unknown>,
  mId: string,
  idx: number,
): Record<string, unknown> {
  const r = readToolResult(ti.result);
  return {
    ...base,
    role: 'tool',
    id: `${mId}:tool:${ti.toolCallId ?? idx}`,
    type: 'tool',
    body: r.body,
    metadata: {
      type: 'tool',
      id: ti.toolCallId,
      toolName: ti.toolName,
      args: ti.args,
      status: ti.state === 'result' ? 'success' : ti.state,
      existingDatasetId: r.existingDatasetId,
      // present only for the visualization tool — lets the UI rebuild the chart
      ...(r.visualization === undefined
        ? {}
        : {visualization: r.visualization}),
      ...(r.config === undefined ? {} : {config: r.config}),
    },
  };
}

/**
 * Normalise a tool-invocation `result` into the fields a consumer re-renders
 * from. Dataset tools return a STRING readout (`…(dataset ID <id>)…`); the
 * visualization tool returns an OBJECT (`{visualization, chartConfig|config,
 * datasetId, sql, description}`).
 */
function readToolResult(result: unknown): {
  body: string;
  existingDatasetId?: string;
  visualization?: unknown;
  config?: unknown;
} {
  if (typeof result === 'string') {
    return {body: result, existingDatasetId: extractDatasetId(result)};
  }
  if (result && typeof result === 'object') {
    const r = result as {
      visualization?: unknown;
      chartConfig?: unknown;
      config?: unknown;
      datasetId?: unknown;
      description?: unknown;
    };
    return {
      body: typeof r.description === 'string' ? r.description : '',
      existingDatasetId:
        typeof r.datasetId === 'string' ? r.datasetId : undefined,
      visualization: r.visualization,
      config: r.chartConfig ?? r.config,
    };
  }
  return {body: ''};
}

/** The typed parts of a Mastra message `content` (array, or `{parts:[…]}`). */
function chatMessageParts(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  const obj = content as {parts?: unknown} | null;
  if (obj && typeof obj === 'object' && Array.isArray(obj.parts)) {
    return obj.parts;
  }
  return [];
}

/**
 * Pull the dataset id out of a tool-result readout, which is shaped
 * `…(dataset ID <id>).…` (see buildDatasetReadout). Used to surface
 * `existingDatasetId` so a consumer can re-run/load a dataset from history.
 */
function extractDatasetId(result: string): string | undefined {
  return /dataset ID ([^)\s.]+)/i.exec(result)?.[1];
}

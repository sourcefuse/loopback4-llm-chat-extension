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
import {MastraInternalBindings} from '../mastra/internal-bindings';
import {deriveResourceId} from '../mastra/resource-id.util';
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
    @inject(MastraInternalBindings.Mastra)
    private readonly mastra: Mastra,
    @inject(MastraInternalBindings.ResourceId, {optional: true})
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
    return result.threads.map(t => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      metadata: t.metadata,
    }));
  }

  /**
   * Load a thread the requester owns, or throw 404. The thread carries its
   * `resourceId`; reject when it isn't the requester's (Memory is per-resource).
   */
  private async ownedThread(threadId: string, resourceId: string) {
    const memory = await this.memory();
    const thread = memory ? await memory.getThreadById({threadId}) : null;
    if (!thread || thread.resourceId !== resourceId) {
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
      id: thread.id,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      metadata: thread.metadata,
      messages: result.messages,
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
    return result.messages;
  }
}

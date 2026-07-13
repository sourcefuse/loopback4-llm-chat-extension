import {inject} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {LLMStreamEventType} from '../../event.types';
import type {ChatState, IChatNode} from '../../state';
import {ChatStore} from '../chat.store';
import {ChatNodes} from '../nodes.enum';

/**
 * Open (or resume) the chat session — the LangGraph `InitSessionNode`. Resolves
 * the requester's tenant-scoped identity, then the Memory thread via
 * {@link ChatStore}: a fresh request creates a thread and emits Init; a resume
 * loads + ownership-checks the existing thread. On any failure it sets `error`
 * so ChatGraph surfaces it and stops. (LangGraph seeded the system prompt +
 * message history into the state here; on Mastra that lives in the agent's
 * instructions + Memory, so this node only establishes the thread.)
 *
 * A DI-resolved `@graphNode` class: `chatStore` is `@service`-injected and the
 * work lives in `execute`, so a host overrides it by rebinding
 * `@graphNode(ChatNodes.InitSession)`.
 */
@graphNode(ChatNodes.InitSession)
export class InitSessionNode implements IChatNode {
  constructor(
    @inject('services.ChatStore') protected readonly chatStore: ChatStore,
  ) {}

  async execute(state: ChatState): Promise<Partial<ChatState>> {
    const requesterResourceId =
      await this.chatStore.resolveRequesterResourceId();
    const resolved = await this.chatStore.resolveThread(
      state.sessionId,
      requesterResourceId,
      id => state.push({type: LLMStreamEventType.Init, data: {sessionId: id}}),
      state.query,
    );
    if ('error' in resolved) return {error: resolved.error};
    return {
      threadId: resolved.threadId,
      resourceId: resolved.resourceId,
      threadTitle: resolved.title,
    };
  }
}

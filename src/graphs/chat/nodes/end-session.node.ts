import {service} from '@loopback/core';
import {graphNode} from '../../../decorators';
import {LLMStreamEventType} from '../../event.types';
import type {ChatState, IChatNode} from '../../state';
import {UsageAccumulator} from '../../../services/usage-accumulator.service';
import {ChatStore} from '../chat.store';
import {ChatNodes} from '../nodes.enum';

/**
 * Close the session — the LangGraph `EndSessionNode`. Emits the terminal
 * TokenCount event with the FULL request total (chat turn + file summaries, not
 * just the chat stream) and persists cumulative counts via {@link ChatStore}.
 * Skips both when the stream's usage did not resolve (error/abort), matching
 * LangGraph's behaviour of only reporting counts on a clean finish.
 *
 * A DI-resolved `@graphNode` class: `chatStore` + `usage` are injected, so a
 * host overrides it by rebinding `@graphNode(ChatNodes.EndSession)`.
 */
@graphNode(ChatNodes.EndSession)
export class EndSessionNode implements IChatNode {
  constructor(
    @service(ChatStore) protected readonly chatStore: ChatStore,
    @service(UsageAccumulator, {optional: true})
    protected readonly usage?: UsageAccumulator,
  ) {}

  async execute(state: ChatState): Promise<void> {
    // usage rejected (error/abort) → no TokenCount, no persist.
    if (!state.usageReady) return;
    // FULL request total from the per-model accumulator (chat + file-summary),
    // falling back to the raw stream usage when no accumulator is bound.
    const {inputTokens, outputTokens} = this.usage
      ? this.totalUsage()
      : (state.rawUsage ?? {inputTokens: 0, outputTokens: 0});
    state.push({
      type: LLMStreamEventType.TokenCount,
      data: {inputTokens, outputTokens},
    });
    await this.chatStore.updateCounts(
      state.threadId ?? '',
      state.threadTitle ?? '',
      inputTokens,
      outputTokens,
    );
  }

  /** Sum the request-scoped per-model accumulator into request totals. */
  protected totalUsage(): {inputTokens: number; outputTokens: number} {
    const snap = this.usage?.snapshot() ?? {};
    let inputTokens = 0;
    let outputTokens = 0;
    for (const m of Object.values(snap)) {
      inputTokens += m.input;
      outputTokens += m.output;
    }
    return {inputTokens, outputTokens};
  }
}

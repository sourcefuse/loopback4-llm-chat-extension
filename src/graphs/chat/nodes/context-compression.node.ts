import {graphNode} from '../../../decorators';
import type {ChatState, IChatNode} from '../../state';
import {ChatNodes} from '../nodes.enum';

/**
 * Context compression — the LangGraph `ContextCompressionNode` (`trim_messages`).
 * In LangGraph this node ran after every tool round: it summed an approximate
 * token count over the accumulated messages and, above `MAX_TOKEN_COUNT`,
 * trimmed the oldest non-system messages before looping back to `CallLLM`.
 *
 * On Mastra, history trimming is handled by Memory rather than a graph node:
 * the chat agent's Memory is configured with `lastMessages` (a sliding window)
 * and the agent's TokenLimiter input processor enforces the token budget
 * (`DEFAULT_MAX_TOKEN_COUNT`, tunable via `MAX_TOKEN_COUNT` /
 * `AIIntegrationConfig.maxTokenCount`). Both run INSIDE `agent.stream` (see
 * {@link CallLLMNode}), so there is no separate scheduled trim step.
 *
 * This class is therefore an OVERRIDE SEAM, not a scheduled node: ChatGraph does
 * not invoke it in the default flow. It is kept for structural parity with the
 * LangGraph version and as the documented extension point. `execute` is a no-op
 * passthrough.
 */
@graphNode(ChatNodes.TrimMessages)
export class ContextCompressionNode implements IChatNode {
  async execute(_state: ChatState): Promise<Partial<ChatState>> {
    return {};
  }
}

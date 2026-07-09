import {graphNode} from '../../../decorators';
import type {ChatState, IChatNode} from '../../state';
import {ChatNodes} from '../nodes.enum';

/**
 * Tool execution — the LangGraph `RunToolNode`. In LangGraph this was a discrete
 * graph node: `CallLLM` emitted `tool_calls`, an edge routed to `RunTool`, which
 * invoked each tool, wrote a `ToolMessage`, then looped back to `CallLLM`.
 *
 * On Mastra there is NO separate scheduling step. `agent.stream({maxSteps})`
 * (see {@link CallLLMNode}) executes tool-calls INSIDE its streaming loop: the
 * Agent runs each tool, feeds the result back to the model and continues, all
 * within one call. Tool-call / tool-status / tool-result chunks surface on
 * `fullStream` and CallLLMNode maps them to SSE events; each tool emits its own
 * Running/Completed/Failed lifecycle events from inside its `execute`.
 *
 * This class is therefore an OVERRIDE SEAM, not a scheduled node: ChatGraph does
 * not invoke it in the default flow. It is kept for structural parity with the
 * LangGraph version and as the documented extension point — to change tool
 * dispatch, override the individual `@graphTool` or the {@link CallLLMNode}
 * loop rather than rebinding this key. `execute` is a no-op passthrough.
 */
@graphNode(ChatNodes.RunTool)
export class RunToolNode implements IChatNode {
  async execute(_state: ChatState): Promise<Partial<ChatState>> {
    return {};
  }
}

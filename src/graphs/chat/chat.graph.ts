import {BindingScope, injectable} from '@loopback/core';
import {LLMStreamEvent, LLMStreamEventType} from '../event.types';
import type {ChatState, IChatNode} from '../state';
import {BaseGraph} from '../base.graph';
import {AsyncEventQueue} from '../../runtime/bridge/async-event-queue';
import {toErrorMessage} from '../../runtime/bridge/agent-stream';
import {ChatNodes} from './nodes.enum';

/**
 * The ordered chat pipeline. `RunTool` and `TrimMessages` are NOT scheduled here
 * — on Mastra the Agent runs tool-calls and trims context inside `CallLLM`'s
 * `agent.stream` loop; those two `@graphNode` classes exist as override seams
 * (see their node files). The four listed nodes are the live, discrete steps.
 */
const CHAT_PIPELINE: ChatNodes[] = [
  ChatNodes.InitSession,
  ChatNodes.SummariseFile,
  ChatNodes.CallLLM,
  ChatNodes.EndSession,
];

/**
 * The chat graph — the Mastra-backed successor of the LangGraph `ChatGraph`.
 * Keeps the same public shape (`execute(query, files, abort, id)` → an async
 * iterable of SSE events) and the same node-resolution / override seam: every
 * node is resolved from the LB4 container by its `@graphNode(key)` tag via
 * {@link BaseGraph._getNodeFn}, so a host overrides any node purely by rebinding
 * its class (exactly as in the LangGraph version). Replaces v2's
 * `WorkflowRunner`.
 *
 * LangGraph compiled a `StateGraph` and let it drive the node hops; Mastra's
 * chat runs on a streaming `Agent`, so this graph resolves + runs its nodes
 * imperatively: InitSession → SummariseFile → CallLLM (which fuses the old
 * CallLLM/RunTool/TrimMessages loop inside `agent.stream`) → EndSession. Each
 * node returns a `Partial<ChatState>` that is merged; an `error` short-circuits
 * the run into a single SSE Error event.
 *
 * A single {@link AsyncEventQueue} enforces total order across the nodes' event
 * pushes and the fullStream pump; the generator yields events as they land.
 *
 * REQUEST-scoped: node collaborators are resolved from the request context.
 */
@injectable({scope: BindingScope.REQUEST})
export class ChatGraph extends BaseGraph {
  async *execute(
    query: string,
    files: Express.Multer.File[] | Express.Multer.File | undefined,
    abort: AbortSignal,
    sessionId?: string,
  ): AsyncIterable<LLMStreamEvent> {
    const queue = new AsyncEventQueue<LLMStreamEvent>({
      overflowValue: {
        type: LLMStreamEventType.Error,
        data: {
          message:
            'SSE event queue overflow: too many events were produced before the client could consume them. The stream was closed early.',
        },
      },
    });

    const state: ChatState = {
      query,
      files,
      abort,
      sessionId,
      push: e => queue.push(e),
    };

    // Fire-and-forget: nodes push onto the queue while the generator below
    // drains it. orchestrate() maps any thrown error to an SSE Error event and
    // always closes the queue, so this never rejects.
    this.orchestrate(state, queue).catch(() => {
      // orchestrate's own catch handles emission + close; this guards an
      // unexpected escape (e.g. a push after close).
    });

    yield* queue;
  }

  /**
   * Resolve each chat node from the container (BaseGraph._getNodeFn — a host
   * override wins by rebinding the key) and run them in order, merging each
   * node's partial state and short-circuiting on `error`.
   */
  protected async orchestrate(
    state: ChatState,
    queue: AsyncEventQueue<LLMStreamEvent>,
  ): Promise<void> {
    try {
      for (const key of CHAT_PIPELINE) {
        const node = (await this._getNodeFn(key)) as unknown as IChatNode;
        const patch = await node.execute(state);
        if (patch) Object.assign(state, patch);
        if (state.error) {
          state.push({
            type: LLMStreamEventType.Error,
            data: {message: state.error},
          });
          return;
        }
      }
    } catch (err) {
      state.push({
        type: LLMStreamEventType.Error,
        data: {message: toErrorMessage(err, 'Unknown error in chat graph')},
      });
    } finally {
      queue.close();
    }
  }
}

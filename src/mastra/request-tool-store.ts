import {LLMStreamEvent} from '../graphs/event.types';
import {IRuntimeTool} from '../graphs/types';

/**
 * Per-request IRuntimeTool registry.
 *
 * `MastraChatAgent` populates this map at the start of each request (keyed by
 * `chatId`) and removes the entry when the request finishes.  The Mastra tool
 * `execute()` callbacks in the host app look up the correct per-request tool
 * instance here using the `threadId` that is forwarded through
 * `agent.stream({ threadId })`.
 *
 * This sidesteps the limitation that Mastra tools are registered once at agent
 * construction time, while LoopBack tools may have request-scoped dependencies.
 */
export const mastraRequestToolStore = new Map<
  string,
  Map<string, IRuntimeTool>
>();

/**
 * Per-request SSE writer registry.
 *
 * Internal tool graphs (e.g. DbQueryGraph, VisualizationGraph) emit
 * `ToolStatus` events via `config.writer` as they execute their nodes.
 * `MastraChatAgent` registers a writer callback here (keyed by `chatId`)
 * before streaming starts. Tools are built with a lazy writer that delegates
 * to this store, so their internal `ToolStatus` events flow back into the
 * SSE stream even though the tool itself runs inside the Mastra agent loop.
 */
export const mastraRequestWriterStore = new Map<
  string,
  (event: LLMStreamEvent) => void
>();

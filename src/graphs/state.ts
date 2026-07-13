import type {LLMStreamEvent} from './event.types';

/**
 * The chat-graph state threaded through the chat nodes (the Mastra-adapted
 * successor of the LangGraph `ChatGraphAnnotation` / `ChatState`). LangGraph
 * accumulated LangChain `messages` in the state because its `StateGraph`
 * reduced them across node hops; Mastra keeps conversation history in Memory
 * (threads), so the state here carries the per-request runtime data the nodes
 * hand off instead: the resolved thread and the file-augmented prompt. Each node
 * returns a `Partial<ChatState>` that {@link ChatGraph} merges, exactly as a
 * LangGraph node returned a partial state; the SSE writer is passed through the
 * state as `push` (the LangGraph `config.writer`).
 *
 * Node COLLABORATORS (ChatStore, LLM configs, Mastra, UsageAccumulator, …) are
 * NOT on the state — every node resolves them through constructor `@inject` /
 * `@service` DI, so a host overrides a node by rebinding its `@graphNode(key)`
 * class without touching the state contract.
 */
export interface ChatState {
  // --- inputs (set by ChatGraph.execute before the nodes run) ---
  /** The raw user prompt for this turn. */
  query: string;
  /** Uploaded attachment(s), normalised by SummariseFileNode. */
  files?: Express.Multer.File[] | Express.Multer.File;
  /** Cancels the in-flight agent stream when the client disconnects. */
  abort: AbortSignal;
  /** Existing thread to resume; absent starts a new session. */
  sessionId?: string;
  /** Enqueue an SSE event (the LangGraph `config.writer`). */
  push(event: LLMStreamEvent): void;

  // --- init-session output ---
  threadId?: string;
  resourceId?: string;
  threadTitle?: string;

  // --- summarise-file output ---
  /** The prompt with each file summary merged in (call-llm's input). */
  augmentedQuery?: string;

  // --- call-llm output (read by end-session) ---
  /** True once the agent stream's usage resolved; gates the TokenCount emit. */
  usageReady?: boolean;
  /** Raw stream usage — the fallback total when no UsageAccumulator is bound. */
  rawUsage?: {inputTokens: number; outputTokens: number};

  // --- control ---
  /** Set by any node to abort the run; ChatGraph emits it as an Error event. */
  error?: string;
}

/**
 * A chat-graph node (the LangGraph `IGraphNode<ChatState>`). Reads the shared
 * {@link ChatState} and returns the fields it changed; ChatGraph merges the
 * result and short-circuits on `error`.
 */
export interface IChatNode {
  execute(state: ChatState): Promise<Partial<ChatState> | void>;
}

/** Outcome of thread resolution — the resolved thread, or an error to surface. */
export type ResolvedThread =
  {threadId: string; resourceId: string; title: string} | {error: string};

/**
 * The subset of the Mastra Memory API the chat graph uses. Narrowed to a
 * structural type (rather than importing the concrete class) because
 * `agent.getMemory()` is loosely typed and `updateThread` is not on the base
 * declaration.
 */
export interface ThreadMemory {
  getThreadById(args: {threadId: string}): Promise<
    | {
        id: string;
        resourceId?: string | null;
        title?: string | null;
        metadata?: Record<string, unknown> | null;
      }
    | null
    | undefined
  >;
  createThread(args: {
    resourceId: string;
    title?: string;
  }): Promise<{id: string}>;
  updateThread?(args: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<unknown>;
}

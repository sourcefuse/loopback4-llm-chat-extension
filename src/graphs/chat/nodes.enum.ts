/**
 * Chat-graph node keys (verbatim from the LangGraph version). Each `@graphNode`
 * class is tagged with its key so a host can override an individual node by
 * rebinding it.
 *
 * In the LangGraph `StateGraph` all six were discrete nodes wired by edges. On
 * Mastra, `CallLLM`, `RunTool` and `TrimMessages` are fused inside one
 * `agent.stream({maxSteps})` call — the Agent runs the model, executes any
 * tool-calls and trims context in a single streaming loop. So `CallLLM` is the
 * live node that owns that loop, while `RunTool` and `TrimMessages` remain as
 * override seams (see their node files) rather than separately-scheduled steps.
 * `InitSession`, `SummariseFile` and `EndSession` stay live, discrete nodes.
 */
export enum ChatNodes {
  CallLLM = 'call_llm',
  TrimMessages = 'trim_messages',
  RunTool = 'run_tool',
  SummariseFile = 'summarise_file',
  InitSession = 'init_session',
  EndSession = 'end_session',
}

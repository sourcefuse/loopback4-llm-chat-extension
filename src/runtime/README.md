# `src/runtime/` — Mastra runtime layer

Quick map for anyone landing here after the LangGraph → Mastra migration
(PR #22, branch `feat/mastra-migration-v2`). The 27 v2 graph nodes did
not disappear — each one moved to one of three Mastra primitives.

## Top-level layout

```
src/
├── graphs/                          # the chat graph (LangGraph structure, preserved)
│ ├── base.graph.ts                  # BaseGraph._getNodeFn — node resolver + override seam
│ ├── state.ts                       # ChatState / IChatNode
│ └── chat/
│   ├── chat.graph.ts                # ChatGraph.execute() — orchestrates the nodes (replaces WorkflowRunner)
│   ├── chat.store.ts                # ChatStore — thread/Memory resolution + token-count persistence
│   ├── chat-metadata.type.ts        # message-metadata types
│   ├── nodes.enum.ts                # ChatNodes (6 keys)
│   └── nodes/                       # the 6 @graphNode classes
│     ├── init-session.node.ts       #   init_session   (live)
│     ├── summarise-file.node.ts     #   summarise_file (live)
│     ├── call-llm.node.ts           #   call_llm       (live — owns agent.stream)
│     ├── run-tool.node.ts           #   run_tool       (override seam — Agent runs tools)
│     ├── context-compression.node.ts#   trim_messages  (override seam — Memory trims)
│     └── end-session.node.ts        #   end_session    (live)
├── runtime/                         # Mastra glue (no LangGraph node analog)
│ ├── bridge/
│ │ ├── agent-stream.ts              # pumpAgentStream: fullStream → SSE + usage (CallLLMNode delegates here)
│ │ ├── async-event-queue.ts         # SSE event ordering across producers
│ │ └── run-registry.ts              # HITL approval flow (sessionId → runId)
│ ├── request-context.builder.ts     # RequestContextBuilder: assembles the per-request Mastra RequestContext
│ ├── model-resolver.ts              # resolveAiSdkModel / modelLabel (shared by builder + SummariseFileNode)
│ ├── _node-shell.ts                 # DI shell for committed workflow steps
│ ├── chat-agent-instructions.ts     # shared chat system prompt builder
│ └── resource-id.util.ts            # tenant-scoped resourceId derivation
└── components/{db-query,visualization}/workflows/   # the two Mastra Workflows
```

There is **no `chat.workflow.ts`** — that is a deliberate decision: chat is
a ReAct loop and Mastra `Agent.stream({maxSteps})` does that natively.
Unlike DbQuery/Visualization (Mastra Workflows), chat keeps the LangGraph
`ChatGraph` shape: a `ChatGraph` orchestrating six `@graphNode` classes
imperatively over an `Agent` + `Memory`, rather than a compiled `StateGraph`.

## The three v2 → v3 routes

| v2 graph           | Nodes | v3 primitive                | File(s)                                                                     |
| ------------------ | :---: | --------------------------- | --------------------------------------------------------------------------- |
| ChatGraph          |   6   | `ChatGraph` + Mastra **Agent** | `graphs/chat/` (ChatGraph orchestrating `@graphNode` classes over an Agent) |
| DbQueryGraph       |  17   | Mastra **Workflow**         | `components/db-query/workflows/generate.workflow.ts` + `improve.workflow.ts` |
| VisualizationGraph |   4   | Mastra **Workflow**         | `components/visualization/workflows/visualization.workflow.ts`              |

Chat picked **Agent** because the loop is `CallLLM → RunTool → CallLLM`
which is exactly what `agent.stream({maxSteps, tools, memory})` already
does. Wrapping that in `createWorkflow` would be redundant. The
LangGraph node layout is still mirrored under `graphs/chat/` so a host can
override any node by rebinding its `@graphNode(key)` class.

DbQuery and Visualization picked **Workflow** because both are explicit
DAGs with parallel fan-out, conditional branches, retry loops, and
shared state — that's what `.parallel().branch().dountil()` is for.

## ChatGraph (6 nodes) → ChatGraph + node classes

Each node is a `@graphNode(ChatNodes.X)` class under `graphs/chat/nodes/`.
`ChatGraph.execute()` runs them in order (init → summarise → call-llm →
end), merging each node's `Partial<ChatState>`; a host overrides any one by
rebinding its key (the `BaseGraph._getNodeFn` seam).

| v2 node                                        | Where it lives now                                                                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InitSessionNode`                              | `init-session.node.ts` (live): `ChatStore.resolveThread` → `memory.createThread({resourceId})` + `Init` SSE event                                                                                                                                        |
| `SummariseFileNode`                            | `summarise-file.node.ts` (live): per-file `generateText` summary merged into the prompt; emits a `Status` per file                                                                                                                                        |
| `CallLLMNode`                                  | `call-llm.node.ts` (live): `agent.stream(messages, {maxSteps: 8})` — native ReAct loop; pumps `fullStream` → SSE                                                                                                                                          |
| `RunToolNode`                                  | `run-tool.node.ts` (**override seam**): tool execution happens inside `agent.stream` — the Agent runs tool-calls and `tool-call`/`tool-result` chunks are mapped to SSE by CallLLMNode; each tool self-emits its lifecycle events                          |
| `ContextCompressionNode` (a.k.a. TrimMessages) | `context-compression.node.ts` (**override seam**): trimming is done by `Memory({options:{lastMessages}})` + the agent's TokenLimiter inside `agent.stream`; no separate scheduled step. Semantic recall is **opt-in** via `MASTRA_SEMANTIC_RECALL=true`   |
| `EndSessionNode`                               | `end-session.node.ts` (live): `TokenCount` SSE event (full request total) + `ChatStore.updateCounts` (thread metadata + `chats` ledger)                                                                                                                   |

Locked SSE wire contract (8 event types) is preserved byte-identical —
the controller surface `POST /reply` is unchanged.

## DbQueryGraph (17 nodes) → generateQueryWorkflow + improveQueryWorkflow

| v2 node                   | v3 step                                                                           | Notes                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IsImprovementNode`       | `improveQueryWorkflow.loadExistingStep`                                           | Real impl — fetches existing dataset, merges delta prompt. `generateQueryWorkflow.isImprovementStep` is an intentional no-op (entry workflow is never in improvement mode). |
| `CheckCacheNode`          | `generateQueryWorkflow.checkCacheStep`                                            | QueryCache retriever → LLM AsIs/Similar/NotRelevant judge.                                                                                                                  |
| `GetTablesNode`           | `generateQueryWorkflow.getTablesStep`                                             | `SchemaStore.get()` deterministic baseline; LLM relevance filter is follow-up.                                                                                              |
| `CheckTemplatesNode`      | `generateQueryWorkflow.checkTemplatesStep`                                        | TemplateCache retriever → LLM exact-match judge.                                                                                                                            |
| `ClassifyChangeNode`      | `generateQueryWorkflow.classifyChangeStep`                                        | Active only in improvement mode (minor/major/rewrite classify).                                                                                                             |
| `PostCacheAndTablesNode`  | `generateQueryWorkflow.postCacheAndTablesStep`                                    | Pure fan-in merger of the 4 parallel branches. Status routing: `AsIs` / `FromTemplate` / `Failed` / `Continue`.                                                             |
| `CheckPermissionsNode`    | (none — preserved at lower layer)                                                 | `PermissionHelper.findMissingPermissions()` runs inside `DataSetHelper.getDataFromDataset()` + `DatasetController` ACL. A.4.                                                |
| `GenerateChecklistNode`   | `generateQueryWorkflow.generateChecklistStep`                                     | LLM builds 3-6 item checklist before dountil loop.                                                                                                                          |
| `SqlGenerationNode`       | `generateQueryWorkflow.sqlAndValidateStep` (composite)                            | One iteration of dountil loop.                                                                                                                                              |
| `SyntacticValidatorNode`  | `generateQueryWorkflow.sqlAndValidateStep` (embedded)                             | `IDbConnector.validate(sql)` DB EXPLAIN call.                                                                                                                               |
| `SemanticValidatorNode`   | `generateQueryWorkflow.sqlAndValidateStep` (embedded)                             | LLM `<valid/>` vs `<invalid>…</invalid>` verdict against checklist.                                                                                                         |
| `GenerateDescriptionNode` | `generateQueryWorkflow.sqlAndValidateStep` (embedded)                             | Description string baked into the SQL generation prompt; will split out if it needs its own retry budget.                                                                   |
| `PostValidationNode`      | (collapsed)                                                                       | Mastra workflows pass `{passed, feedback, attempts}` through dountil natively — no explicit merge step needed.                                                              |
| `FixQueryNode`            | `improveQueryWorkflow.fixQueryStep`                                               | Dountil loop body for improve workflow. Same syntactic + semantic validators embedded.                                                                                      |
| `VerifyChecklistNode`     | (embedded in semantic validator)                                                  | LLM verdict against checklist is exactly the v2 verify-checklist behaviour.                                                                                                 |
| `SaveDataSetNode`         | `generateQueryWorkflow.saveDatasetStep` + `improveQueryWorkflow.saveImprovedStep` | Real `IDataSetStore.create / updateById` calls + tenantId from `AuthenticationBindings.CURRENT_USER`.                                                                       |
| `FailedNode`              | `generateQueryWorkflow.failedStep` + `improveQueryWorkflow.failedStep`            | Terminal step at the end of the loop's "no" branch.                                                                                                                         |

Extra v3 steps that have no 1:1 v2 node (they were inline logic inside
v2 nodes that needed their own Mastra step):

- `generateQueryWorkflow.returnCachedStep` — was inline at top of v2 `PostCacheAndTables`'s `AsIs` branch.
- `generateQueryWorkflow.saveDatasetFromTemplateStep` — was inline at top of v2 `PostCacheAndTables`'s `FromTemplate` branch.
- `generateQueryWorkflow.getColumnsStep` — was part of v2 `GetColumns` (separate node restored here as its own step).

## VisualizationGraph (4 nodes) → visualizationWorkflow

Direct 1:1 mapping.

| v2 node                   | v3 step                                         |
| ------------------------- | ----------------------------------------------- |
| `SelectVisualizationNode` | `visualizationWorkflow.selectVisualisationStep` |
| `CallQueryGenerationNode` | `visualizationWorkflow.callQueryGenerationStep` |
| `GetDatasetDataNode`      | `visualizationWorkflow.getDatasetDataStep`      |
| `RenderVisualizationNode` | `visualizationWorkflow.renderVisualizationStep` |

Visualizers (`PieVisualizer`, `BarVisualizer`, `LineVisualizer`) and the
`@visualizer()` decorator are preserved. `renderVisualizationStep`
dispatches to them via the consumer-registered registry, same way v2
did. A.3.

## How the layers compose at request time

```
POST /reply
 └─ GenerationController.reply()
 └─ GenerationService.generate()
 └─ ChatGraph.execute() ← REQUEST-scoped
 ├─ InitSessionNode: memory.createThread + Init
 ├─ SummariseFileNode: file loop + Status events
 ├─ CallLLMNode: build per-request RequestContext (consumer-bound chatLlm + Mastra tools)
 ├─ CallLLMNode: agent.stream(messages, {memory, requestContext, maxSteps})
 │ ↓
 │ Mastra Agent runs the ReAct loop. Whenever the model
 │ fires a tool call, Mastra invokes the tool's execute().
 │ ↓
 │ Mastra tool wrappers (4 of them) live in
 │ src/components/{db-query,visualization}/tools/*.tool.ts.
 │ Three of them call workflows:
 │ - get-data-as-dataset → mastra.getWorkflow('generateQueryWorkflow').createRun().start()
 │ - improve-dataset → mastra.getWorkflow('improveQueryWorkflow').createRun().start()
 │ - generate-visualization → mastra.getWorkflow('visualizationWorkflow').createRun().start()
 │ The fourth (ask-about-dataset) runs a one-shot Mastra Agent inline.
 │ ↓
 ├─ CallLLMNode pump: drain stream.fullStream → AsyncEventQueue
 │ (text-delta → Message, tool-call → Tool, tripwire → Error, etc.)
 ├─ EndSessionNode: await stream.usage → TokenCount + ChatStore.updateCounts
 └─ yield* queue
```

## RequestContext flow

`CallLLMNode` populates the RequestContext keys before `agent.stream()`. Every
workflow step body can read them via the native `requestContext`
parameter:

| Key           | Purpose                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resourceId`  | Tenant-scoped identity for Memory.scope='resource'..                                                                                                                                                                                            |
| `eventWriter` | `(LLMStreamEvent) → void` push onto SSE queue. Tools + steps use this to emit `Log` / `ToolStatus`.                                                                                                                                             |
| `dbConnector` | Optional `IDbConnector` from `DbQueryAIExtensionBindings.Connector`.                                                                                                                                                                            |
| `chatLlm`     | Optional consumer-bound `ChatLLM` (`MastraModelConfig`). LLM-driven steps use it with `generateText({model, prompt})` from `ai` v6.                                                                                                             |
| `lb4Ctx`      | Full LB4 `Context`. Any step that needs a preserved helper resolves it lazily via `lb4Ctx.get<X>(key, {optional: true})` — `DbSchemaHelperService`, `SchemaStore`, `TableSearchService`, `PermissionHelper`, `DataSetHelper`, `TemplateHelper`. |

## Branch lineage

- `feat/mastra-migration` — earlier exploration; followed the "every v2 node becomes its own Mastra step" approach (1:1 port). That branch never landed.
- `feat/mastra-migration-v2` (this branch / PR #22) — current implementation. Same end state for DbQuery + Visualization (1:1 for 14 of 17 / 4 of 4 nodes), but consolidates the 5 validator-family v2 nodes (SqlGeneration + Syntactic + Semantic + GenerateDescription + VerifyChecklist) into a single composite `sqlAndValidateStep`, and replaces ChatGraph entirely with Mastra `Agent`

## Further reading

- `the migration plan` — Agent vs Workflow decision (locked).
- `the migration plan` -9.3 — Workflow skeletons.
- `the migration plan` A.1 — full v2 → v3 feature parity matrix.
- `the migration plan` A.4 — what's preserved at the helper layer.
- v2 node source for any step: `git show 4be9767^:src/components/db-query/nodes/<name>.node.ts` or `…visualization/nodes/<name>.node.ts`.

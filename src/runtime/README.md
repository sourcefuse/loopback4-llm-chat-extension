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
│ ├── model-resolver.ts              # modelLabel / isAiSdkLanguageModel (shared by builder + SummariseFileNode)
│ ├── _node-shell.ts                 # makeNodeShell — DI shell for committed graph nodes
│ ├── chat-agent-instructions.ts     # shared chat system prompt builder
│ ├── index.ts                       # `/mastra` subpath: node shells + schemas for recomposing graphs
│ └── resource-id.util.ts            # tenant-scoped resourceId derivation
└── components/
  ├── db-query/
  │ ├── db-query.graph.ts            # the db-query graph wiring (dbQueryGraph + generate/improve sub-graphs)
  │ └── nodes/                       # the 23 @graphNode classes (one file per node)
  └── visualization/
    ├── visualization.graph.ts       # the visualization graph wiring
    └── nodes/                       # the 4 @graphNode classes
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
| DbQueryGraph       |  17   | Mastra **Workflow**         | `components/db-query/db-query.graph.ts` (wiring) + `components/db-query/nodes/` (the `@graphNode` classes) |
| VisualizationGraph |   4   | Mastra **Workflow**         | `components/visualization/visualization.graph.ts` (wiring) + `components/visualization/nodes/` |

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

## DbQueryGraph → dbQueryGraph (+ generateQueryGraph / improveQueryGraph)

Every v2 db-query node was restored **1:1 as its own `@graphNode` class** under
`components/db-query/nodes/` — the earlier consolidation into a single composite
`sqlAndValidateStep` was reverted for full LangGraph fidelity. The graph wiring
in `db-query.graph.ts` registers three workflows on the Mastra singleton:

- `dbQueryGraph` (id `db-query`) — the single entry both db-query tools call. Its
  one node `isImprovementNode` dispatches on `datasetId` (absent → generate,
  present → improve) by resolving the sub-graph below via `mastra.getWorkflow`.
- `generateQueryGraph` (id `generate-query`):
  `parallel[check_cache, get_tables, check_templates]` → `post_cache_and_tables`
  → branch(`FromTemplate` → `save_dataset_from_template` / `AsIs` →
  `return_cached` / `Continue` → `get_columns`) → `generate_checklist` →
  `verify_checklist` → `classify_change` →
  `dountil( sql_generation → parallel[syntactic_validator, semantic_validator, generate_description] → post_validation )`
  → branch(`failed` / `save_dataset`).
- `improveQueryGraph` (id `improve-query`): `load_existing` →
  `dountil(fix_query)` → branch(`improve_failed` / `save_improved`).

| v2 node                   | Node file (key)                                       | Notes                                                                                                                        |
| ------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `IsImprovementNode`       | `is-improvement.node.ts` (`is_improvement`)           | Entry dispatch of `dbQueryGraph` — routes to the generate or improve sub-graph on `datasetId`.                              |
| `CheckCacheNode`          | `check-cache.node.ts` (`check_cache`)                 | QueryCache retriever → LLM AsIs/Similar/NotRelevant judge.                                                                  |
| `GetTablesNode`           | `get-tables.node.ts` (`get_tables`)                   | `SchemaStore.get()` deterministic baseline; LLM relevance filter is follow-up.                                             |
| `CheckTemplatesNode`      | `check-templates.node.ts` (`check_templates`)         | TemplateCache retriever → LLM exact-match judge.                                                                           |
| `ClassifyChangeNode`      | `classify-change.node.ts` (`classify_change`)         | Active only in improvement mode (minor/major/rewrite classify).                                                            |
| `PostCacheAndTablesNode`  | `post-cache-and-tables.node.ts` (`post_cache_and_tables`) | Fan-in merger of the parallel branches. Status routing: `AsIs` / `FromTemplate` / `Failed` / `Continue`.               |
| `CheckPermissionsNode`    | `check-permissions.node.ts` (`check_permissions`)     | Restored node; `PermissionHelper.findMissingPermissions()` is also enforced at the ACL/`DataSetHelper` layer. A.4.         |
| `GenerateChecklistNode`   | `generate-checklist.node.ts` (`generate_checklist`)   | LLM builds 3-6 item checklist before the dountil loop.                                                                    |
| `SqlGenerationNode`       | `sql-generation.node.ts` (`sql_generation`)           | First step of each dountil iteration; `buildPrompt()` override seam.                                                       |
| `SyntacticValidatorNode`  | `syntactic-validator.node.ts` (`syntactic_validator`) | `IDbConnector.validate(sql)` DB EXPLAIN call. Runs in the parallel validator fan-out.                                     |
| `SemanticValidatorNode`   | `semantic-validator.node.ts` (`semantic_validator`)   | LLM `<valid/>` vs `<invalid>…</invalid>` verdict against checklist. Parallel fan-out.                                     |
| `GenerateDescriptionNode` | `generate-description.node.ts` (`generate_description`) | Streams the dataset description. Parallel fan-out.                                                                        |
| `PostValidationNode`      | `post-validation.node.ts` (`post_validation`)         | Merges the parallel validators → `{passed, feedback, attempts}` for the dountil predicate; reselects tables on failure.   |
| `FixQueryNode`            | `fix-query.node.ts` (`fix_query`)                     | Dountil loop body for the improve path. Same validators embedded via `SqlGenerationHelper`.                              |
| `VerifyChecklistNode`     | `verify-checklist.node.ts` (`verify_checklist`)       | LLM verdict against checklist before generation.                                                                          |
| `SaveDataSetNode`         | `save-dataset-node.ts` (`save_dataset`) + `save-improved.node.ts` (`save_improved`) | Real `IDataSetStore.create / updateById` + tenantId from `AuthenticationBindings.CURRENT_USER`.     |
| `FailedNode`              | `failed.node.ts` (`failed`) + `improve-failed.node.ts` (`improve_failed`) | Terminal node on the loop's "no" branch (improve terminal keeps id `failed`, DI key `improve_failed`). |

Extra nodes with no 1:1 v2 node (inline v2 logic promoted to its own node):

- `return-cached.node.ts` (`return_cached`) — was inline at the top of v2 `PostCacheAndTables`'s `AsIs` branch.
- `save-dataset-from-template.node.ts` (`save_dataset_from_template`) — was inline in v2 `PostCacheAndTables`'s `FromTemplate` branch.
- `get-columns.node.ts` (`get_columns`) — the relevant-table narrowing split out of v2 `GetTables` as its own node.
- `load-existing.node.ts` (`load_existing`) — improve-path entry; fetches the existing dataset and merges the delta prompt.

## VisualizationGraph (4 nodes) → visualizationGraph

Direct 1:1 mapping — one `@graphNode` file per node under
`components/visualization/nodes/`, wired in `visualization.graph.ts`
(registered as `visualizationGraph`, id `visualization`).

| v2 node                   | Node file (key)                                             |
| ------------------------- | ---------------------------------------------------------- |
| `SelectVisualizationNode` | `select-visualization.node.ts` (`select_visualization`)     |
| `CallQueryGenerationNode` | `call-query-generation.node.ts` (`call_query_generation`)   |
| `GetDatasetDataNode`      | `get-dataset-data.node.ts` (`get_dataset_data`)             |
| `RenderVisualizationNode` | `render-visualization.node.ts` (`render_visualization`)     |

Visualizers (`PieVisualizer`, `BarVisualizer`, `LineVisualizer`) and the
`@visualizer()` decorator are preserved. `RenderVisualizationNode`
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
 │ - get-data-as-dataset → mastra.getWorkflow('dbQueryGraph').createRun().start()
 │ - improve-dataset → mastra.getWorkflow('dbQueryGraph').createRun().start()
 │     (the shared entry graph dispatches to the generate/improve sub-graph on datasetId)
 │ - generate-visualization → mastra.getWorkflow('visualizationGraph').createRun().start()
 │ The fourth (ask-about-dataset) makes ONE cheap-tier tracedGenerateText call inline (no agent).
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
- `feat/mastra-migration-v2` (this branch / PR #22) — current implementation. DbQuery + Visualization are restored to full LangGraph node fidelity: every v2 node is its own `@graphNode` class (an earlier revision had consolidated the 5 validator-family nodes into one composite `sqlAndValidateStep`; that was reverted so each node stays independently overridable). ChatGraph is replaced entirely with a Mastra `Agent`.

## Further reading

- `the migration plan` — Agent vs Workflow decision (locked).
- `the migration plan` -9.3 — Workflow skeletons.
- `the migration plan` A.1 — full v2 → v3 feature parity matrix.
- `the migration plan` A.4 — what's preserved at the helper layer.
- v2 node source for any step: `git show 4be9767^:src/components/db-query/nodes/<name>.node.ts` or `…visualization/nodes/<name>.node.ts`.

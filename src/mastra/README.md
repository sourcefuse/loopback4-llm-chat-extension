# `src/mastra/` — Mastra runtime layer

Quick map for anyone landing here after the LangGraph → Mastra migration
(PR #22, branch `feat/mastra-migration-v2`). The 27 v2 graph nodes did
not disappear — each one moved to one of three Mastra primitives.

## Top-level layout

```
src/mastra/
├── bridge/
│ ├── workflow-runner.ts # REQUEST-scoped. Replaces ChatGraph.execute()
│ ├── async-event-queue.ts # SSE event ordering across producers
│ └── run-registry.ts # HITL approval flow (sessionId → runId)
└── workflows/
 ├── db-query/
 │ ├── generate.workflow.ts # Replaces v2 DbQueryGraph (17 nodes)
 │ └── improve.workflow.ts # Improvement variant (subset of DbQuery)
 └── visualization.workflow.ts # Replaces v2 VisualizationGraph (4 nodes)
```

There is **no `chat.workflow.ts`** — that is a deliberate decision from
the migration plan : chat is a ReAct loop and Mastra
`Agent.stream({maxSteps})` does that natively. The 6 v2 ChatGraph nodes
collapsed into the `WorkflowRunner` + `Agent` + `Memory` triple.

## The three v2 → v3 routes

| v2 graph | Nodes | v3 primitive | File(s) |
| --------------------- | :---: | --------------------- | -------------------------------------------------------- |
| ChatGraph | 6 | Mastra **Agent** | `bridge/workflow-runner.ts` (per-request `Agent` build) |
| DbQueryGraph | 17 | Mastra **Workflow** | `workflows/db-query/generate.workflow.ts` + `improve.workflow.ts` |
| VisualizationGraph | 4 | Mastra **Workflow** | `workflows/visualization.workflow.ts` |

Chat picked **Agent** because the loop is `CallLLM → RunTool → CallLLM`
which is exactly what `agent.stream({maxSteps, tools, memory})` already
does. Wrapping that in `createWorkflow` would be redundant.

DbQuery and Visualization picked **Workflow** because both are explicit
DAGs with parallel fan-out, conditional branches, retry loops, and
shared state — that's what `.parallel().branch().dountil()` is for.

## ChatGraph (6 nodes) → Agent + WorkflowRunner

| v2 node | Where it lives now |
| --- | --- |
| `InitSessionNode` | `WorkflowRunner.run()` pre-block: `memory.createThread({resourceId})` + `Init` SSE event |
| `SummariseFileNode` | `WorkflowRunner.run()` file loop: emits `Status` events; per-file summarisation pre-pass (current commit emits Status only; LLM summarisation rejoins as a future commit) |
| `CallLLMNode` | `agent.stream(messages, {maxSteps: 60})` — native ReAct loop |
| `RunToolNode` | `Agent.tools` registry + Mastra's internal tool-execution + `fullStream` `tool-call` / `tool-result` chunks pumped to SSE by `WorkflowRunner` |
| `ContextCompressionNode` (a.k.a. TrimMessages) | `Memory({options: {lastMessages: 20}})` — automatic message-history trim. Semantic recall (no v2 equivalent) is **opt-in** via `MASTRA_SEMANTIC_RECALL=true`; default OFF so latency matches v2 even when a vector store is bound for the db-query cache |
| `EndSessionNode` | `WorkflowRunner.run()` post-stream block: `await stream.usage` → `TokenCount` SSE event + `UsageAccumulator.add()` |

Locked SSE wire contract (8 event types) is preserved byte-identical —
the controller surface `POST /reply` is unchanged..

## DbQueryGraph (17 nodes) → generateQueryWorkflow + improveQueryWorkflow

| v2 node | v3 step | Notes |
| --- | --- | --- |
| `IsImprovementNode` | `improveQueryWorkflow.loadExistingStep` | Real impl — fetches existing dataset, merges delta prompt. `generateQueryWorkflow.isImprovementStep` is an intentional no-op (entry workflow is never in improvement mode). |
| `CheckCacheNode` | `generateQueryWorkflow.checkCacheStep` | QueryCache retriever → LLM AsIs/Similar/NotRelevant judge. |
| `GetTablesNode` | `generateQueryWorkflow.getTablesStep` | `SchemaStore.get()` deterministic baseline; LLM relevance filter is follow-up. |
| `CheckTemplatesNode` | `generateQueryWorkflow.checkTemplatesStep` | TemplateCache retriever → LLM exact-match judge. |
| `ClassifyChangeNode` | `generateQueryWorkflow.classifyChangeStep` | Active only in improvement mode (minor/major/rewrite classify). |
| `PostCacheAndTablesNode` | `generateQueryWorkflow.postCacheAndTablesStep` | Pure fan-in merger of the 4 parallel branches. Status routing: `AsIs` / `FromTemplate` / `Failed` / `Continue`. |
| `CheckPermissionsNode` | (none — preserved at lower layer) | `PermissionHelper.findMissingPermissions()` runs inside `DataSetHelper.getDataFromDataset()` + `DatasetController` ACL. A.4. |
| `GenerateChecklistNode` | `generateQueryWorkflow.generateChecklistStep` | LLM builds 3-6 item checklist before dountil loop. |
| `SqlGenerationNode` | `generateQueryWorkflow.sqlAndValidateStep` (composite) | One iteration of dountil loop. |
| `SyntacticValidatorNode` | `generateQueryWorkflow.sqlAndValidateStep` (embedded) | `IDbConnector.validate(sql)` DB EXPLAIN call. |
| `SemanticValidatorNode` | `generateQueryWorkflow.sqlAndValidateStep` (embedded) | LLM `<valid/>` vs `<invalid>…</invalid>` verdict against checklist. |
| `GenerateDescriptionNode` | `generateQueryWorkflow.sqlAndValidateStep` (embedded) | Description string baked into the SQL generation prompt; will split out if it needs its own retry budget. |
| `PostValidationNode` | (collapsed) | Mastra workflows pass `{passed, feedback, attempts}` through dountil natively — no explicit merge step needed. |
| `FixQueryNode` | `improveQueryWorkflow.fixQueryStep` | Dountil loop body for improve workflow. Same syntactic + semantic validators embedded. |
| `VerifyChecklistNode` | (embedded in semantic validator) | LLM verdict against checklist is exactly the v2 verify-checklist behaviour. |
| `SaveDataSetNode` | `generateQueryWorkflow.saveDatasetStep` + `improveQueryWorkflow.saveImprovedStep` | Real `IDataSetStore.create / updateById` calls + tenantId from `AuthenticationBindings.CURRENT_USER`. |
| `FailedNode` | `generateQueryWorkflow.failedStep` + `improveQueryWorkflow.failedStep` | Terminal step at the end of the loop's "no" branch. |

Extra v3 steps that have no 1:1 v2 node (they were inline logic inside
v2 nodes that needed their own Mastra step):

- `generateQueryWorkflow.returnCachedStep` — was inline at top of v2 `PostCacheAndTables`'s `AsIs` branch.
- `generateQueryWorkflow.saveDatasetFromTemplateStep` — was inline at top of v2 `PostCacheAndTables`'s `FromTemplate` branch.
- `generateQueryWorkflow.getColumnsStep` — was part of v2 `GetColumns` (separate node restored here as its own step).

## VisualizationGraph (4 nodes) → visualizationWorkflow

Direct 1:1 mapping.

| v2 node | v3 step |
| --- | --- |
| `SelectVisualizationNode` | `visualizationWorkflow.selectVisualisationStep` |
| `CallQueryGenerationNode` | `visualizationWorkflow.callQueryGenerationStep` |
| `GetDatasetDataNode` | `visualizationWorkflow.getDatasetDataStep` |
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
 └─ WorkflowRunner.run() ← REQUEST-scoped
 ├─ pre: memory.createThread + Init
 ├─ pre: file loop + Status events
 ├─ build per-request Agent (with consumer-bound chatLlm + Mastra tools)
 ├─ agent.stream(messages, {memory, requestContext, maxSteps})
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
 ├─ pump task: drain stream.fullStream → AsyncEventQueue
 │ (text-delta → Message, tool-call → Tool, tripwire → Error, etc.)
 ├─ post: await stream.usage → TokenCount + UsageAccumulator.add
 └─ yield* queue
```

## RequestContext flow

`WorkflowRunner.run()` populates 5 keys before `agent.stream()`. Every
workflow step body can read them via the native `requestContext`
parameter:

| Key | Purpose |
| --- | --- |
| `resourceId` | Tenant-scoped identity for Memory.scope='resource'.. |
| `eventWriter` | `(LLMStreamEvent) → void` push onto SSE queue. Tools + steps use this to emit `Log` / `ToolStatus`. |
| `dbConnector` | Optional `IDbConnector` from `DbQueryAIExtensionBindings.Connector`. |
| `chatLlm` | Optional consumer-bound `ChatLLM` (`MastraModelConfig`). LLM-driven steps use it with `generateText({model, prompt})` from `ai` v6. |
| `lb4Ctx` | Full LB4 `Context`. Any step that needs a preserved helper resolves it lazily via `lb4Ctx.get<X>(key, {optional: true})` — `DbSchemaHelperService`, `SchemaStore`, `TableSearchService`, `PermissionHelper`, `DataSetHelper`, `TemplateHelper`. |

## Branch lineage

- `feat/mastra-migration` — earlier exploration; followed the "every v2 node becomes its own Mastra step" approach (1:1 port). That branch never landed.
- `feat/mastra-migration-v2` (this branch / PR #22) — current implementation. Same end state for DbQuery + Visualization (1:1 for 14 of 17 / 4 of 4 nodes), but consolidates the 5 validator-family v2 nodes (SqlGeneration + Syntactic + Semantic + GenerateDescription + VerifyChecklist) into a single composite `sqlAndValidateStep`, and replaces ChatGraph entirely with Mastra `Agent`

## Further reading

- `the migration plan` — Agent vs Workflow decision (locked).
- `the migration plan` -9.3 — Workflow skeletons.
- `the migration plan` A.1 — full v2 → v3 feature parity matrix.
- `the migration plan` A.4 — what's preserved at the helper layer.
- v2 node source for any step: `git show 4be9767^:src/components/db-query/nodes/<name>.node.ts` or `…visualization/nodes/<name>.node.ts`.

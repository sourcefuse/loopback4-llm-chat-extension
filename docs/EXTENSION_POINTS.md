# Extension Points

Everything the consumer app can override in `lb4-llm-chat-component`. The
extension ships sensible defaults for each binding; override only what you need.

There are two binding namespaces:

- **`AiIntegrationBindings`** — the host-facing surface (model tiers, embedder,
  transport, vector store, cache, limiter, system context, config).
- **`MastraInternalBindings`** — the Mastra runtime infra (storage, tools,
  observability, run registry, resource id). Not part of the host model surface,
  but exported so you can swap a backend (e.g. Postgres storage, Redis run
  registry, a different observability exporter).

```ts
import {AiIntegrationBindings, MastraInternalBindings} from 'lb4-llm-chat-component';
```

---

## 1. Model tiers (`AiIntegrationBindings`)

Each tier is a `BindingKey<LLMProvider>` where `LLMProvider` is an AI-SDK
`LanguageModel`. Bind a provider per tier. Unbound optional tiers fall back to
`ChatLLM`.

| Key | Required | Used for | Fallback |
|-----|----------|----------|----------|
| `ChatLLM` | via `MASTRA_DEFAULT_CHAT_MODEL` (see below) | top-level ReAct chat agent | — |
| `SmartLLM` | optional | SQL generation, semantic validation | `ChatLLM` |
| `CheapLLM` | optional | cache/template judge, checklist, get-columns, SQL-error classification | `ChatLLM` |
| `FileLLM` | optional | file summarisation | `ChatLLM` |
| `SmartNonThinkingLLM` | optional | strict `generateObject` (line visualizer) — reasoning model with thinking disabled | `ChatLLM` |
| `EmbeddingModel` | optional | semantic cache / templates, and Memory semantic recall (opt-in) | — |

```ts
this.bind(AiIntegrationBindings.SmartLLM).toProvider(MySmartModelProvider);
this.bind(AiIntegrationBindings.CheapLLM).toProvider(MyCheapModelProvider);
```

> The chat agent has **no silent default model** — set
> `MASTRA_DEFAULT_CHAT_MODEL` (e.g. `google/gemini-1.5-flash`,
> `anthropic/claude-3-5-sonnet-20241022`) or the provider throws at startup, to
> avoid surprise OpenAI billing when `OPENAI_API_KEY` is present.

## 2. Transport, cache, limiter, context, config (`AiIntegrationBindings`)

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `Transport` | `ITransport` | `SSETransport` (streaming) | how `/reply` emits events. Bind `HttpTransport` (buffered JSON array) for non-streaming clients, or set `DISABLE_STREAMING=true`. |
| `VectorStore` | `MastraVector` | none | vector store for the db-query semantic cache / templates. Also enables Memory semantic recall **only when** `MASTRA_SEMANTIC_RECALL=true` (see §4). |
| `Cache` | `ICache` | in-process | response/dedup cache. |
| `LimitStrategy` | `ILimitStrategy` | none | rate/usage limiting. |
| `SystemContext` | `string[]` | `[]` | extra system-prompt lines appended to the chat agent instructions. |
| `Config` | `AIIntegrationConfig` | — | component config (model list, permission keys, db-query flags). |

## 3. Mastra runtime infra (`MastraInternalBindings`)

| Key | Type | Default | Override with |
|-----|------|---------|---------------|
| `Storage` | `MastraCompositeStore` | LibSQL (`DefaultMastraStorageProvider`) | `PostgresMastraStorageProvider` (§5) or any `MastraCompositeStore` |
| `Tools` | `ToolStore` | `DefaultToolsProvider` (4 built-in tools) | a provider that adds/removes tools (§6) |
| `Observability` | `Observability` | unset | a Mastra `Observability` instance (Langfuse / LangSmith / multi) |
| `RunRegistry` | `IRunRegistry` | `InProcessRunRegistry` | a Redis-backed registry for multi-pod HITL |
| `ResourceId` | `string` | per-request (tenant/user) | a custom resource-id resolver |

```ts
this.bind(MastraInternalBindings.Storage).toProvider(PostgresMastraStorageProvider);
```

## 4. Memory

Memory is created in `MastraProvider` with `lastMessages: 20` (trims history by
count — the v2 `ContextCompressionNode` analogue). Two capabilities are
**opt-in and default OFF** so consumers don't pay for them silently:

| Env | Default | Effect |
|-----|---------|--------|
| `MASTRA_DEFAULT_CHAT_MODEL` | — (required) | the chat agent's model |
| `MASTRA_SEMANTIC_RECALL` | `false` | enable cross-thread semantic recall (requires `VectorStore` + `EmbeddingModel`). **Has no v2 equivalent** — leaving it off keeps latency flat as history grows. |
| `MASTRA_SEMANTIC_RECALL_TOPK` | `5` | recall match count (when enabled) |
| `MASTRA_SEMANTIC_RECALL_RANGE` | `3` | messages of context per match (when enabled) |
| `MASTRA_GENERATE_TITLE` | `false` | auto-generate a thread title (one extra LLM call per new thread) |
| `MASTRA_TITLE_MODEL` | chat model | cheaper model for the title call |
| `MAX_TOKEN_COUNT` | `8192` | trims oldest non-system messages above this running token count |

> Semantic recall at `scope:'resource'` scans the resource's **entire**
> cross-thread message history, which grows every request. Because a
> `VectorStore` is usually bound for the db-query cache, recall would otherwise
> auto-enable and latency would climb over a session — hence the explicit
> `MASTRA_SEMANTIC_RECALL` gate.

## 5. Postgres storage (issue #17)

Default storage is LibSQL (SQLite file, `MASTRA_STORAGE_URL`, default
`file:./mastra.db`). To persist threads/messages in Postgres, bind the opt-in
provider:

```ts
import {PostgresMastraStorageProvider, MastraInternalBindings} from 'lb4-llm-chat-component';
this.bind(MastraInternalBindings.Storage).toProvider(PostgresMastraStorageProvider);
```

Configure via env (connection-string **or** discrete host fields):

| Env | Default | Notes |
|-----|---------|-------|
| `MASTRA_PG_CONNECTION_STRING` | — | e.g. `postgresql://user:pass@host:5432/db` |
| `MASTRA_PG_HOST` / `MASTRA_PG_PORT` | — / `5432` | host form |
| `MASTRA_PG_DATABASE` / `MASTRA_PG_USER` / `MASTRA_PG_PASSWORD` | — | host form |
| `MASTRA_PG_SCHEMA` | `mastra` | schema for the `mastra_*` tables |
| `MASTRA_PG_SSL` | off | `true` to enable TLS |
| `MASTRA_STORAGE_ID` | `mastra-pg` | store id |

Fail-closed: the provider throws if neither a connection string nor a complete
host config is present (no silent fallback to a different backend).

## 6. Tools

The four built-in tools (`get-data-as-dataset`, `improve-dataset`,
`ask-about-dataset`, `generate-visualization`) are registered by
`DefaultToolsProvider` into the `ToolStore` bound at
`MastraInternalBindings.Tools`. Each tool implements `IGraphTool`.

To add or replace tools, implement `IGraphTool` and bind a provider that returns
a `ToolStore` listing your tools:

```ts
import {IGraphTool, ToolStore, MastraInternalBindings} from 'lb4-llm-chat-component';

class MyToolsProvider implements Provider<ToolStore> {
  value(): ToolStore {
    return {list: [/* ...your IGraphTool instances... */]};
  }
}
this.bind(MastraInternalBindings.Tools).toProvider(MyToolsProvider);
```

## 7. Observability

Bind a Mastra `Observability` instance (Langfuse, LangSmith, or a multi-exporter)
to `MastraInternalBindings.Observability`. Relevant env: `LANGFUSE_*`,
`LANGSMITH_*` / `LANGCHAIN_*`, `OTEL_SERVICE_NAME`, `OTEL_SAMPLE_RATE`,
`ENABLE_TRACING`. The chat agent must be the registered Mastra agent for its
spans to reach the exporter (the extension streams `mastra.getAgent('chatAgent')`
for this reason).

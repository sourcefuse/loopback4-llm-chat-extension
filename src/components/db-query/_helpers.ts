import type {RequestContext} from '@mastra/core/request-context';
import type {MastraModelConfig} from '@mastra/core/llm';
import type {Tool} from '@mastra/core/tools';
import {SpanType} from '@mastra/core/observability';
import type {TracingContext} from '@mastra/core/observability';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {generateText} from 'ai';
import type {LanguageModel} from 'ai';
import debugFactory from 'debug';

// Step/activity log channel — every workflow step status flows here so a
// developer running the consumer app can watch progress with
// `DEBUG=ai-integration:*` (or `DEBUG=ai-integration:steps`).
const stepDbg = debugFactory('ai-integration:steps');

/**
 * Coerce a dataset/template id to a string. DB stores (e.g. SQLite
 * autoincrement) hand back a numeric id; the workflow output contract and
 * the tool-layer extraction are string-typed, so a number would otherwise
 * be silently dropped (the tool reports the run failed even though the row
 * was persisted). Returns '' for null/undefined.
 */
export function idToString(v: unknown): string {
  // Primitive id coercion: DB autoincrement IDs arrive as numbers; string IDs
  // pass through unchanged. Objects never occur in practice (number|string
  // only); JSON-stringify them rather than fall into '[object Object]'.
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  return JSON.stringify(v);
}
import {
  LLMStreamEventType,
  type LLMStreamEvent,
} from '../../graphs/event.types';
import type {NodeResolver} from '../../graphs/types';

/** Inferred return type of `generateText` without further constraining
 * the (tools, output) generics — used as `tracedGenerateText`'s return
 * type so callers see the same `{text, usage, ...}` shape as a direct
 * `generateText` call. */
type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>;
import type {
  DataSetHelper,
  DbSchemaHelperService,
  PermissionHelper,
  TemplateHelper,
} from './services';
import type {SchemaStore} from './services/schema.store';
import type {
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
  IQueryTemplateStore,
} from './types';
import type {IVisualizer} from '../visualization/types';
// SQL-prompt building lives in ./prompts (kept _helpers under SonarQube's
// 1000-line cap). Re-exported so existing `from './_helpers'` import sites
// (buildGenerateSqlPrompt, buildImproveSqlPrompt, SqlGenInput) are unaffected.
export * from './prompts';

/**
 * Bounded contract for what workflow steps may read from Mastra's
 * RequestContext. Replaces the previous full-LB4-Context exposure
 * (least-privilege violation per migration plan Section 3.4). Every
 * field is optional so workflow steps stay runnable when the consumer
 * has not bound the relevant component.
 *
 * ChatGraph.execute() resolves each binding once at request entry +
 * sets every key. Step bodies use the typed accessors below — no
 * `lb4Ctx.get(...)` lookups inside step execute().
 */
export interface MastraRcShape {
  resourceId: string;
  eventWriter: (event: LLMStreamEvent) => void;
  chatLlm?: LanguageModel;
  // Tier slots — see AiIntegrationBindings.Mastra(Cheap|Smart|SmartNonThinking)LLM.
  // Accessors below fall back to `chatLlm` when a tier is unbound, so workflow
  // steps stay runnable under partial configuration. Wiring high-volume calls
  // (cache/template judge, checklist, get-columns) to a cheaper tier closes the
  // cost regression vs main where these all ran on `CheapLLM`.
  cheapLlm?: LanguageModel;
  smartLlm?: LanguageModel;
  smartNonThinkingLlm?: LanguageModel;
  // Per-request chat-agent configuration. The chatAgent registered on the
  // Mastra singleton resolves its model / tools / instructions from these
  // keys (function-typed Agent params, see Provider). Threading them
  // through RequestContext — instead of building a detached `new Agent()`
  // per request — keeps the agent registered with the Mastra instance so
  // its spans reach the configured observability exporter (Langfuse).
  agentModel?: MastraModelConfig;
  agentTools?: Record<string, Tool>;
  agentInstructions?: string;
  dbConnector?: IDbConnector;
  authUser?: IAuthUserWithPermissions;
  datasetStore?: IDataSetStore;
  // Consumer DbQueryConfig — gates whether the AI may read result rows
  // (`readAccessForAI`, default off) and the row cap (`maxRowsForAI`).
  // Matches the v2 SaveDataSetNode contract: by default the AI never
  // sees actual data, only the datasetId + a "done" acknowledgement.
  config?: DbQueryConfig;
  templateStore?: IQueryTemplateStore;
  schemaStore?: SchemaStore;
  schemaHelper?: DbSchemaHelperService;
  templateHelper?: TemplateHelper;
  dataSetHelper?: DataSetHelper;
  // Tenant/user permission gate. Used by the template path to enforce
  // table-level ACLs upfront (parity with v2 CheckTemplatesNode) — a matched
  // template the user lacks table permissions for is skipped so the run falls
  // through to normal generation rather than serving unauthorized data.
  permissionHelper?: PermissionHelper;
  queryCache?: {
    invoke: (
      input: string,
    ) => Promise<Array<{pageContent: string; metadata: {id?: string}}>>;
  };
  templateCache?: {
    invoke: (
      input: string,
    ) => Promise<Array<{pageContent: string; metadata: {id?: string}}>>;
  };
  visualizers?: IVisualizer[];
  // Per-request resolver for `@graphNode(key)` classes (see graphs/types
  // NodeResolver). ChatGraph publishes a closure over the request-scoped
  // LB4 context so a committed step shell can fetch its DI-backed
  // implementation. This is the narrow seam that gives steps real DI without
  // re-exposing the full LB4 Context to step bodies.
  resolveNode?: NodeResolver;
}

export type MastraRc = RequestContext<MastraRcShape>;

// The request-context arg every node passes to emitToolStatus/logStepDetail.
// Lives here (not in ../types) because it derives from MastraRc above and
// ../types is imported BY this file — putting it there would be a cycle.
export type Rc = MastraRc | undefined;

export function getChatLlm(rc?: MastraRc): LanguageModel | undefined {
  return rc?.get('chatLlm');
}
/**
 * Cheap-tier accessor — falls back to `chatLlm` when unbound so the step
 * stays runnable. Use for high-volume, low-stakes calls: cache/template
 * judge, checklist gen, get-columns, fix-query, etc.
 */
export function getCheapLlm(rc?: MastraRc): LanguageModel | undefined {
  return rc?.get('cheapLlm') ?? rc?.get('chatLlm');
}
/**
 * Smart-tier accessor — falls back to `chatLlm` when unbound. Use for
 * heavier reasoning: SQL generation, semantic validation.
 */
export function getSmartLlm(rc?: MastraRc): LanguageModel | undefined {
  return rc?.get('smartLlm') ?? rc?.get('chatLlm');
}
/**
 * Reasoning-model-with-thinking-disabled accessor — falls back to
 * `chatLlm`. Use where strict structured-output mode (generateObject)
 * misbehaves with "thinking" chunks, e.g. line visualizer schema.
 */
export function getSmartNonThinkingLlm(
  rc?: MastraRc,
): LanguageModel | undefined {
  return rc?.get('smartNonThinkingLlm') ?? rc?.get('chatLlm');
}

// isCachedDatasetUsable / loadCachedSampleQuery moved onto DataSetHelper
// (isCachedDatasetUsable / loadSampleQuery) — dataset-read + dislike logic.
// CheckCacheNode calls them via the injected DataSetHelper.
export function getDbQueryConfig(rc?: MastraRc): DbQueryConfig | undefined {
  return rc?.get('config');
}
export function getPermissionHelper(
  rc?: MastraRc,
): PermissionHelper | undefined {
  return rc?.get('permissionHelper');
}

/**
 * Resolve an AI SDK call-time `temperature` from env, mirroring main's
 * per-provider knobs:
 *   - `CLAUDE_TEMPERATURE`     (Anthropic)
 *   - `BEDROCK_TEMPERATURE`    (AWS Bedrock)
 *   - `OPENAI_TEMPERATURE`     (OpenAI / OpenRouter)
 *
 * On v2 these were silently dropped because the Mastra provider classes
 * are stateless (built per AI SDK convention — temperature is a call-time
 * setting, not a construction one). First non-empty env wins in the order
 * above. Returns `undefined` when none are set so the AI SDK falls back
 * to the provider's own default.
 */
export function resolveEnvTemperature(): number | undefined {
  const raw =
    process.env.CLAUDE_TEMPERATURE ??
    process.env.BEDROCK_TEMPERATURE ??
    process.env.OPENAI_TEMPERATURE;
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Build the AI SDK `providerOptions` payload that enables / disables
 * Anthropic + Bedrock reasoning ("thinking") per env:
 *   - `CLAUDE_THINKING=true`    → enable thinking on Anthropic + Bedrock calls
 *   - `CLAUDE_THINKING_BUDGET`  → max reasoning token budget (default 1024)
 *
 * Mirrors the v2 LangGraph extension's behaviour (`anthropic.provider.ts`
 * + `bedrock.provider.ts` on main) which read the same env vars and
 * passed them into the LangChain provider config. The Mastra equivalent
 * applies them at `agent.stream()` / `generateText()` call-time via AI
 * SDK provider options — the provider classes themselves stay stateless.
 *
 * `forceThinkingOff: true` overrides env to `disabled` regardless. Used
 * by call sites that target a "non-thinking" tier (e.g. line visualizer
 * `generateObject`, which strict-mode hates with thinking chunks).
 *
 * Returns `undefined` when nothing needs to be set (thinking off + no
 * override) so call sites can spread `...(opts ?? {})` cleanly.
 */
export function buildProviderOptions(
  opts: {
    forceThinkingOff?: boolean;
  } = {},
): Record<string, Record<string, unknown>> | undefined {
  const envOn = process.env.CLAUDE_THINKING === 'true';
  const enabled = opts.forceThinkingOff ? false : envOn;
  if (!enabled && !opts.forceThinkingOff) {
    // No env opt-in + no explicit-off-override → don't set providerOptions
    // at all so the model uses its default (off for Bedrock/Anthropic).
    return undefined;
  }
  const budgetTokens = Number.parseInt(
    process.env.CLAUDE_THINKING_BUDGET ?? '1024',
    10,
  );
  // OpenRouter reasoning shape — Claude via OpenRouter does NOT honour
  // `providerOptions.anthropic.thinking` (those only apply when using the
  // direct @ai-sdk/anthropic provider). OpenRouter's AI SDK provider
  // accepts `reasoning: {enabled, max_tokens|effort}` instead, so we emit
  // BOTH shapes — AI SDK strips unknown providerOptions keys per provider,
  // so the same object works for direct Anthropic, Bedrock, AND OpenRouter
  // Claude/o-series routes.
  // `max_tokens` is OpenRouter's required snake_case API key — disable the
  // naming-convention rule locally rather than camelCasing it (would break
  // the wire request).
  const openRouterReasoning = enabled
    ? // eslint-disable-next-line @typescript-eslint/naming-convention
      {enabled: true, max_tokens: budgetTokens}
    : {enabled: false};
  const type = enabled ? 'enabled' : 'disabled';
  return {
    anthropic: {
      thinking: enabled ? {type, budgetTokens} : {type},
    },
    bedrock: {
      reasoningConfig: enabled ? {type, budgetTokens} : {type},
    },
    openrouter: {
      reasoning: openRouterReasoning,
    },
  };
}

/**
 * Wrap an AI SDK `generateText` call in a Mastra MODEL_GENERATION child
 * span so workflow LLM calls show up as proper LLM rows in
 * Langfuse/LangSmith — not absorbed into the surrounding `workflow_step`
 * span. Without this the exporters see one big `gpt-4o` for the agent
 * reply and nothing else even though cheap/smart tiers fire underneath.
 *
 * `tracing.currentSpan` is the workflow step's span; the child span
 * carries the resolved model id + provider so the exporter can render
 * tier-specific GENERATION rows.
 */
/** Span/result classification for a traced generateText call. */
export type GenResultType =
  | 'tool_selection'
  | 'response_generation'
  | 'reasoning'
  | 'planning';

export async function tracedGenerateText(args: {
  model: LanguageModel;
  prompt: string;
  tracing?: TracingContext;
  /** Short label used as the span name, e.g. `'cache-judge'`. */
  label: string;
  resultType?: GenResultType;
  /** When true, forces Anthropic/Bedrock thinking off regardless of
   * `CLAUDE_THINKING` env (e.g. line-visualizer strict structured output
   * that misbehaves with thinking chunks). */
  forceThinkingOff?: boolean;
}): Promise<GenerateTextReturn> {
  const {
    model,
    prompt,
    tracing,
    label,
    resultType = 'response_generation',
    forceThinkingOff,
  } = args;
  const modelId = (model as {modelId?: string}).modelId;
  const provider = modelId?.includes('/') ? modelId.split('/')[0] : undefined;
  const span = tracing?.currentSpan?.createChildSpan({
    type: SpanType.MODEL_GENERATION,
    name: label,
    // `input` MUST be set here (and `output` on end) — the LangSmith/Langfuse
    // exporter maps span input/output to the run's inputs/outputs. Without it
    // these workflow LLM spans (get-columns, sql-generation, classify-sql-error,
    // …) showed blank prompt/completion in the trace, even though attributes
    // were present.
    input: prompt,
    attributes: {model: modelId, provider, resultType},
  });
  const providerOptions = buildProviderOptions({forceThinkingOff});
  const temperature = resolveEnvTemperature();
  try {
    const result = await generateText({
      model,
      prompt,
      ...(temperature === undefined ? {} : {temperature}),
      ...(providerOptions ? {providerOptions: providerOptions as never} : {}),
    });
    span?.end({
      output: result.text,
      // Usage MUST go inside `attributes` (Mastra reads `attributes.usage`);
      // a top-level `usage:` field is ignored, which is why these workflow
      // LLM spans previously reported 0 tokens in Langfuse/LangSmith while
      // the agent span (which sets it correctly) did not.
      attributes: {model: modelId, provider, resultType, usage: result.usage},
    });
    return result;
  } catch (err) {
    span?.error({error: err as Error});
    throw err;
  }
}

export function emitToolStatus(
  rc: MastraRc | undefined,
  id: string,
  status: string,
): void {
  // Developer-facing activity log on the `debug` channel — restores the
  // step/activity visibility v2 main emitted as Log events. Toggle from the
  // consumer app with `DEBUG=ai-integration:*` (off by default; no console
  // spam in production, and not a raw `console` call so it doesn't trip the
  // no-console lint/Sonar rule).
  stepDbg('[%s] %s', id, status);
  const writer = rc?.get('eventWriter');
  if (!writer) return;
  writer({
    type: LLMStreamEventType.ToolStatus,
    data: {id, status},
  });
}

/**
 * Server-ONLY developer detail log. Restores the value-carrying messages
 * LangGraph (main) emitted as server-side `Log` stream events — generated SQL,
 * picked tables, validation-failure reasons, matched template — which carried
 * the actual dynamic values, not just a stage label.
 *
 * Unlike {@link emitToolStatus} this does NOT emit a client `tool-status`
 * event: the verbose detail stays on the `DEBUG=ai-integration:steps` console
 * channel and never reaches the UI. That mirrors LangGraph, whose `Log` events
 * the SSE/HTTP transport dropped before the client — so this is parity, not a
 * new client-facing behaviour, and it won't leak schema/SQL detail to users.
 */
export function logStepDetail(id: string, detail: string): void {
  stepDbg('[%s] %s', id, detail);
}

/**
 * Stream a single reasoning/description token to the client as a
 * `tool-status` event carrying `thinkingToken` — the exact wire shape the v2
 * LangGraph extension emitted from its (streaming) generate-description node.
 * Gives the UI a live "thinking" heartbeat during generation. No per-token
 * `debug` log (would be far too noisy); the accumulated description is logged
 * once by the caller.
 */
export function emitThinkingToken(
  rc: MastraRc | undefined,
  token: string,
): void {
  const writer = rc?.get('eventWriter');
  if (!writer || !token) return;
  writer({
    type: LLMStreamEventType.ToolStatus,
    data: {thinkingToken: token},
  });
}

const SQL_FENCE = '```';
const SQL_FENCE_LANG = '```sql';
const JSON_FENCE_LANG = '```json';

/**
 * Strip leading ```<lang> / ``` fences and trailing ``` plus whitespace.
 * Pure string ops to avoid super-linear regex backtracking (s5852).
 */
function stripFences(text: string, langFence: string): string {
  let s = text.trim();
  if (s.startsWith(langFence)) {
    s = s.slice(langFence.length);
  } else if (s.startsWith(SQL_FENCE)) {
    s = s.slice(SQL_FENCE.length);
  } else {
    // no leading fence — nothing to strip
  }
  if (s.endsWith(SQL_FENCE)) {
    s = s.slice(0, -SQL_FENCE.length);
  }
  return s.trim();
}

export function stripSqlFences(text: string): string {
  return stripFences(text, SQL_FENCE_LANG);
}

export function stripJsonFences(text: string): string {
  return stripFences(text, JSON_FENCE_LANG);
}

export type SqlAttemptResult = {
  sql: string;
  passed: boolean;
  feedback?: string;
  description?: string;
  /** Widened table set when a syntactic failure was classified as
   * `table_not_found` (mirrors v2's ReselectTables path). Undefined when
   * the set was not expanded; callers carry it into the next dountil
   * iteration so SQL re-generation sees the missing table/column. */
  tables?: string[];
};

/**
 * Read the cached schema hash, returning '' when the SchemaStore /
 * SchemaHelper aren't bound or the schema isn't loaded yet.
 */
export function computeSchemaHash(
  schemaHelper: DbSchemaHelperService | undefined,
  schemaStore: SchemaStore | undefined,
): {schemaHash: string; tablesFromSchema: string[]} {
  if (!schemaHelper || !schemaStore) {
    return {schemaHash: '', tablesFromSchema: []};
  }
  try {
    const schema = schemaStore.get();
    return {
      schemaHash: schemaHelper.computeHash(schema),
      tablesFromSchema: Object.keys(schema.tables),
    };
  } catch {
    return {schemaHash: '', tablesFromSchema: []};
  }
}

/**
 * Verify the bindings save-dataset / save-dataset-from-template need.
 * Returns null when either is missing so the caller can short-circuit
 * to its fallback shape.
 */
export function resolvePersistDeps(
  store: IDataSetStore | undefined,
  user: IAuthUserWithPermissions | undefined,
): {
  store: IDataSetStore;
  user: IAuthUserWithPermissions & {tenantId: string};
} | null {
  if (!store || !user?.tenantId) return null;
  return {store, user: user as IAuthUserWithPermissions & {tenantId: string}};
}

/**
 * One-shot column-relevance LLM call for getColumnsNode. Returns the
 * narrowed table list or `null` when the LLM rejects / returns
 * unparseable JSON / the schema is missing.
 */
/**
 * Outcome of the relevant-table LLM pass:
 * - `tables`       → the narrowed list of tables that can answer the query.
 * - `unanswerable` → the LLM judged that NONE of the tables hold the data the
 *                    query needs; `reason` is a short user-facing message
 *                    (mirrors v2 `get-tables`'s `replyToUser`). Callers
 *                    short-circuit to the failed terminal WITHOUT generating
 *                    SQL — the early gate that stops an unanswerable prompt
 *                    from burning MAX_VALIDATION_ATTEMPTS smart-tier attempts.
 * - `unknown`      → no LLM bound, empty schema, or an LLM/parse error. NOT a
 *                    judgement of unanswerability — callers fall back to the
 *                    full upstream table set and proceed as before.
 */
export type RelevantTablesResult =
  | {kind: 'tables'; tables: string[]}
  | {kind: 'unanswerable'; reason: string}
  | {kind: 'unknown'};

const UNANSWERABLE_KEY = '__unanswerable__';

export async function pickRelevantTables(args: {
  chatLlm: LanguageModel;
  prompt: string;
  tablesWithColumns: Record<string, string[]>;
  upstreamTables: string[];
  /**
   * Rich schema text ({@link getSchemaForPrompt}: DDL + FK relations +
   * per-table context). When present it is shown ALONGSIDE the column map so
   * the selector can see how tables link and what columns mean — without it the
   * selector only sees bare names and falsely answers "unanswerable / no link"
   * for join questions (v2's GetTablesNode always showed table descriptions).
   */
  schema?: string;
  tracing?: TracingContext;
}): Promise<RelevantTablesResult> {
  const {chatLlm, prompt, tablesWithColumns, upstreamTables, schema, tracing} =
    args;
  if (Object.keys(tablesWithColumns).length === 0) return {kind: 'unknown'};
  const schemaBlock = schema
    ? `\nSchema details (descriptions, foreign-key relations and rules — use these to understand how tables link):\n${schema}\n`
    : '';
  const llmPrompt = `You are an AI assistant that identifies relevant columns from database tables based on a user's query.

Tables with columns:
${JSON.stringify(tablesWithColumns, null, 2)}
${schemaBlock}
User query: ${prompt}

Assume tables CAN be related to each other through id / foreign-key columns even
when a join is not spelled out — never answer "unanswerable" merely because the
link is not described. If doubtful about a table's relevance, INCLUDE it.

Only return the unanswerable response when the required DATA genuinely does not
exist in ANY of these tables. In that case return exactly:
{"${UNANSWERABLE_KEY}": "<one short sentence telling the user what data is missing or asking them to rephrase>"}

Otherwise return a JSON object where each relevant table name is a key and the
value is an array of relevant column names. Include primary-key and foreign-key
columns even if not directly mentioned. Return ONLY valid JSON.`;
  try {
    const result = await tracedGenerateText({
      model: chatLlm,
      prompt: llmPrompt,
      tracing,
      label: 'get-columns',
      resultType: 'planning',
    });
    const cleaned = stripJsonFences(result.text);
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const reason = parsed[UNANSWERABLE_KEY];
    if (typeof reason === 'string' && reason.trim().length > 0) {
      return {kind: 'unanswerable', reason: reason.trim()};
    }
    const filtered = Object.keys(parsed).filter(t =>
      upstreamTables.includes(t),
    );
    return filtered.length > 0
      ? {kind: 'tables', tables: filtered}
      : {kind: 'unknown'};
  } catch {
    return {kind: 'unknown'};
  }
}

// getAllSchemaTables / getTablesWithColumns / getSchemaForPrompt moved onto
// SchemaStore (allTableNames / tablesWithColumns / schemaForPrompt) — the
// schema-read owner. Steps call them via the injected SchemaStore.

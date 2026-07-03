import type {RequestContext} from '@mastra/core/request-context';
import type {MastraModelConfig} from '@mastra/core/llm';
import type {Tool} from '@mastra/core/tools';
import {SpanType} from '@mastra/core/observability';
import type {TracingContext} from '@mastra/core/observability';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {generateText, streamText} from 'ai';
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
} from '../../../graphs/event.types';
import type {StepResolver} from '../../../graphs/types';
import {LABEL_SQL_GENERATION} from './constants';

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
} from '../services';
import type {SchemaStore} from '../services/schema.store';
import {SqlValidatorService} from '../services/sql-validator.service';
import {DatasetActionType} from '../constant';
import type {
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
  IQueryTemplateStore,
} from '../types';
import type {IVisualizer} from '../../visualization/types';
// SQL-prompt building lives in ./prompts (kept _helpers under SonarQube's
// 1000-line cap). Re-exported so existing `from '../_helpers'` import sites
// (buildGenerateSqlPrompt, buildImproveSqlPrompt, SqlGenInput) are unaffected.
export * from './prompts';
import {formatChecks} from './prompts';
import type {SqlGenInput} from './prompts';

/**
 * Bounded contract for what workflow steps may read from Mastra's
 * RequestContext. Replaces the previous full-LB4-Context exposure
 * (least-privilege violation per migration plan Section 3.4). Every
 * field is optional so workflow steps stay runnable when the consumer
 * has not bound the relevant component.
 *
 * WorkflowRunner.run() resolves each binding once at request entry +
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
  // Per-request resolver for `@step(key)` classes (see graphs/types
  // StepResolver). WorkflowRunner publishes a closure over the request-scoped
  // LB4 context so a committed step shell can fetch its DI-backed
  // implementation. This is the narrow seam that gives steps real DI without
  // re-exposing the full LB4 Context to step bodies.
  resolveStep?: StepResolver;
}

export type MastraRc = RequestContext<MastraRcShape>;

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

/**
 * A cached dataset may be reused only if it still exists AND no user has
 * disliked it (restores v2 CheckCacheNode behaviour). A disliked dataset is
 * a signal the cached query was wrong, so we must regenerate rather than
 * re-serve it. Missing/erroring lookups also fail closed (treat as unusable)
 * so the cache step degrades to a miss instead of returning a dead id.
 */
export async function isCachedDatasetUsable(
  store: IDataSetStore,
  datasetId: string,
): Promise<boolean> {
  try {
    const dataset = await store.findById(datasetId, {
      include: [{relation: 'actions'}],
    });
    if (!dataset) return false;
    return !dataset.actions?.some(a => a.action === DatasetActionType.Disliked);
  } catch {
    return false;
  }
}

/**
 * Load a "Similar" cache hit's query to seed SQL generation as a worked
 * example (restores v2 sampleSql/sampleSqlPrompt). Returns undefined — so the
 * caller silently falls back to generating from scratch — when the store is
 * unbound, the dataset is missing/empty, or it was disliked (a disliked query
 * is a poor example to imitate).
 */
export async function loadCachedSampleQuery(
  store: IDataSetStore | undefined,
  datasetId: string,
  samplePrompt: string,
): Promise<{sampleSql: string; samplePrompt: string} | undefined> {
  if (!store) return undefined;
  try {
    const dataset = await store.findById(datasetId, {
      include: [{relation: 'actions'}],
    });
    if (!dataset?.query) return undefined;
    if (dataset.actions?.some(a => a.action === DatasetActionType.Disliked)) {
      return undefined;
    }
    return {sampleSql: dataset.query, samplePrompt};
  } catch {
    return undefined;
  }
}
/**
 * Pick the SQL-generation tier (restores v2 SqlGenerationNode cost
 * optimisation, which v3 dropped — every gen ran on the smart tier). Cheap
 * tier is good enough and ~halves cost/latency when:
 *   - this is a validation-fix RETRY (the query is close, only small edits),
 *   - or it's a single-table query (no joins to reason about) — unless the
 *     consumer forces smart via
 *     `nodes.sqlGenerationNode.useSmartLLMForSingleTableQueries`.
 * Multi-table first attempts use the smart tier.
 */
export function shouldUseCheapForSqlGen(
  config: DbQueryConfig | undefined,
  tableCount: number,
  priorAttempts: number,
): boolean {
  // any prior attempt means this is a validation-fix retry
  if (priorAttempts > 0) return true;
  const forceSmartSingle =
    config?.nodes?.sqlGenerationNode?.useSmartLLMForSingleTableQueries === true;
  return tableCount <= 1 && !forceSmartSingle;
}

export function getDbQueryConfig(rc?: MastraRc): DbQueryConfig | undefined {
  return rc?.get('config');
}
export function getPermissionHelper(
  rc?: MastraRc,
): PermissionHelper | undefined {
  return rc?.get('permissionHelper');
}

/**
 * Drop tables the user lacks read permission for (v2 `_filterByPermissions`).
 * Shared by getTablesStep (initial selection) and the table_not_found reselect
 * so a widened table set can never reintroduce an unauthorized table. Strips
 * the `schema.` prefix before the lookup. Fail-open when no helper is bound.
 */
export function filterTablesByPermission(
  tables: string[],
  permissionHelper: PermissionHelper | undefined,
): string[] {
  if (!permissionHelper) return tables;
  return tables.filter(
    t =>
      permissionHelper.findMissingPermissions([
        t.toLowerCase().slice(t.indexOf('.') + 1),
      ]).length === 0,
  );
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

type SqlGenStage = {sql: string; description?: string; error?: string};

async function runGenerationStage(args: {
  chatLlm: LanguageModel | undefined;
  prompt: string;
  tables: string[];
  columns?: Record<string, string[]>;
  schema?: string;
  checks?: string[];
  checklist?: string;
  feedback?: string;
  initialSql?: string;
  sampleSql?: string;
  samplePrompt?: string;
  buildPrompt: (input: SqlGenInput) => string;
  buildDescription?: (sql: string, prompt: string) => string;
  tracing?: TracingContext;
}): Promise<SqlGenStage> {
  const fallback: SqlGenStage = {sql: args.initialSql ?? ''};
  if (!args.chatLlm || !args.prompt) return fallback;
  const gen = await generateSqlOnce(
    args.chatLlm,
    args.buildPrompt({
      prompt: args.prompt,
      tables: args.tables,
      columns: args.columns,
      schema: args.schema,
      checks: args.checks,
      checklist: args.checklist,
      feedback: args.feedback,
      originalSql: args.initialSql,
      sampleSql: args.sampleSql,
      samplePrompt: args.samplePrompt,
    }),
    args.tracing,
  );
  if (gen.error) return {...fallback, error: gen.error};
  if (!gen.sql) return fallback;
  return {
    sql: gen.sql,
    description: args.buildDescription?.(gen.sql, args.prompt),
  };
}

function buildDescriptionPrompt(
  prompt: string,
  sql: string,
  checks?: string[],
): string {
  return `In a few short sentences, explain step by step what the following SQL query does to answer the user's request. Be concise and user-facing.

User request: ${prompt}
SQL: ${sql}${formatChecks(checks)}

Describe the query — do not return SQL.`;
}

/** Remove `<think>…</think>` / `<thinking>…</thinking>` blocks. */
function stripThinkTags(text: string): string {
  // Paired blocks: anchored by both literal tags → linear, no backtracking.
  const paired = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '');
  // Orphan closing tag (a reasoning model emitted a close with no open):
  // drop everything up to and including the LAST one. lastIndexOf — not a
  // lazy-prefix regex — so there's no super-linear backtracking (S5852).
  let cut = -1;
  let tagLen = 0;
  for (const tag of ['</think>', '</thinking>']) {
    const i = paired.lastIndexOf(tag);
    if (i > cut) {
      cut = i;
      tagLen = tag.length;
    }
  }
  return (cut === -1 ? paired : paired.slice(cut + tagLen)).trim();
}

/** Text of a stream delta chunk, or '' when the chunk is not a text/reasoning
 * delta. Keeps {@link streamDescription}'s loop flat (S134). */
function deltaText(part: unknown): string {
  const p = part as {type?: string; text?: string; textDelta?: string};
  if (p.type !== 'text-delta' && p.type !== 'reasoning-delta') return '';
  return p.text ?? p.textDelta ?? '';
}

/** Drain a streamText fullStream, emit each delta as a thinkingToken, and
 * return the accumulated text. Extracted from {@link streamDescription} to
 * keep both functions under the complexity limit. */
async function pumpThinking(
  stream: AsyncIterable<unknown>,
  rc: MastraRc | undefined,
): Promise<string> {
  let out = '';
  for await (const part of stream) {
    const token = deltaText(part);
    if (!token) continue;
    out += token;
    emitThinkingToken(rc, token);
  }
  return out;
}

/**
 * Stream a natural-language description of the generated SQL, emitting each
 * delta to the client as a `thinkingToken` tool-status event (restores v2's
 * streaming generate-description node + its live reasoning heartbeat). Runs
 * CONCURRENTLY with the validators (see {@link runValidationStage}), so it
 * adds no critical-path latency — exactly the v2 PreValidation fan-out shape.
 * Returns the accumulated, think-tag-stripped description (or '' on any error
 * / no model). Single-shot stream → the OpenRouter reasoning-replay stall does
 * not apply.
 */
async function streamDescription(args: {
  model: LanguageModel | undefined;
  prompt: string;
  sql: string;
  checks?: string[];
  rc?: MastraRc;
  tracing?: TracingContext;
}): Promise<string> {
  const {model, prompt, sql, checks, rc, tracing} = args;
  if (!model || !sql || !prompt) return '';
  const modelId = (model as {modelId?: string}).modelId;
  const provider = modelId?.includes('/') ? modelId.split('/')[0] : undefined;
  const descriptionPrompt = buildDescriptionPrompt(prompt, sql, checks);
  const span = tracing?.currentSpan?.createChildSpan({
    type: SpanType.MODEL_GENERATION,
    name: 'generate-description',
    // See tracedGenerateText: input/output map to the run's inputs/outputs in
    // the LangSmith/Langfuse exporter; omit them and the span shows blank I/O.
    input: descriptionPrompt,
    attributes: {model: modelId, provider, resultType: 'response_generation'},
  });
  try {
    const result = streamText({
      model,
      prompt: descriptionPrompt,
    });
    const out = await pumpThinking(result.fullStream, rc);
    span?.end({
      output: stripThinkTags(out),
      // Usage inside `attributes` (Mastra reads `attributes.usage`); a
      // top-level `usage:` is ignored → 0 tokens on the span.
      attributes: {model: modelId, provider, usage: await result.usage},
    });
    return stripThinkTags(out);
  } catch (err) {
    span?.error({error: err as Error});
    return '';
  }
}

async function runValidationStage(args: {
  sql: string;
  chatLlm: LanguageModel | undefined;
  dbConnector: IDbConnector | undefined;
  prompt: string;
  checklist?: string;
  checks?: string[];
  onStatus?: (stage: 'syntactic' | 'semantic') => void;
  tracing?: TracingContext;
  lastAttempt?: boolean;
  /** Cheap-tier model for the streaming description; when set (and a valid
   * SQL candidate exists) the description runs concurrently with the
   * validators and its tokens stream to the client as `thinkingToken`. */
  descriptionLlm?: LanguageModel;
  rc?: MastraRc;
  /** The read-only-SQL / semantic validation boundary (injected by the step;
   * a consumer can rebind `services.SqlValidatorService` to change policy). */
  sqlValidator: SqlValidatorService;
}): Promise<{
  passed: boolean;
  feedback?: string;
  kind?: 'syntactic' | 'semantic';
  description?: string;
}> {
  const {sql} = args;
  if (!sql)
    return {
      passed: false,
      feedback: 'SQL generation produced an empty query.',
      kind: 'syntactic',
    };
  // Run the two validators CONCURRENTLY: the syntactic check is a DB EXPLAIN
  // and the semantic check is an LLM call — independent, so there's no reason
  // to pay them sequentially. Syntactic failure is authoritative (the SQL
  // won't run), so it wins when both return.
  args.onStatus?.('syntactic');
  args.onStatus?.('semantic');
  // Run syntactic (DB EXPLAIN), semantic (LLM judge), AND the streaming
  // description (LLM, when enabled) CONCURRENTLY — v2's PreValidation fan-out.
  // The description overlaps the semantic call, so it adds ~no wall-clock; its
  // tokens stream to the client as `thinkingToken` while validation runs.
  const [syntactic, semantic, description] = await Promise.all([
    args.sqlValidator.validateSyntactic(sql, args.dbConnector),
    args.sqlValidator.validateSemantic({
      sql,
      chatLlm: args.chatLlm,
      prompt: args.prompt,
      checklist: args.checklist,
      tracing: args.tracing,
    }),
    streamDescription({
      model: args.descriptionLlm,
      prompt: args.prompt,
      sql,
      checks: args.checks,
      rc: args.rc,
      tracing: args.tracing,
    }),
  ]);
  const desc = description || undefined;
  if (!syntactic.passed)
    return {...syntactic, kind: 'syntactic', description: desc};
  // On the final attempt, executable SQL beats an empty dataset: the
  // semantic judge is advisory, so don't let it fail the run outright.
  if (args.lastAttempt) return {passed: true, description: desc};
  return {...semantic, kind: 'semantic', description: desc};
}

/**
 * Run one full SQL attempt: generation -> syntactic validation ->
 * semantic validation. Returns the final attempt result with passed
 * flag + optional feedback to feed back into the dountil loop.
 */
export async function runSqlAttempt(args: {
  chatLlm: LanguageModel | undefined;
  dbConnector: IDbConnector | undefined;
  prompt: string;
  tables: string[];
  columns?: Record<string, string[]>;
  schema?: string;
  checks?: string[];
  checklist?: string;
  feedback?: string;
  /** A user-validated "Similar" cache query shown to the model as a worked
   * example (restores v2 sampleSql/sampleSqlPrompt). */
  sampleSql?: string;
  samplePrompt?: string;
  buildPrompt: (input: SqlGenInput) => string;
  initialSql?: string;
  buildDescription?: (sql: string, prompt: string) => string;
  onStatus?: (stage: 'syntactic' | 'semantic') => void;
  tracing?: TracingContext;
  /** True on the final dountil iteration — accept syntactically-valid SQL
   * even if the (advisory) semantic judge dislikes it, so an executable
   * query is never thrown away in favour of an empty dataset. */
  lastAttempt?: boolean;
  /** Full schema table list. When supplied, a syntactic failure is
   * classified (v2 SyntacticValidatorNode): a `table_not_found` verdict
   * widens the allowed set with the related tables for the next iteration. */
  allTables?: string[];
  /** Cheap-tier model for error classification (v2 used CheapLLM). Falls
   * back to {@link chatLlm} when unset. */
  cheapLlm?: LanguageModel;
  /** Fired when the table set was widened after a `table_not_found` verdict,
   * so the step can emit a "Reselecting tables" status (v2 ReselectTables). */
  onReselectTables?: (mergedTables: string[]) => void;
  /** Cheap-tier model for the streaming description (v2 generate-description).
   * When set, a natural-language description streams to the client as
   * `thinkingToken` events concurrently with validation. Omit to disable. */
  descriptionLlm?: LanguageModel;
  /** RequestContext, used ONLY to reach the SSE `eventWriter` for
   * `thinkingToken` streaming (the LangGraph `config.writer` equivalent). */
  rc?: MastraRc;
  /** Injected by the step (constructor `@inject`) — used to re-filter a widened
   * table set on a `table_not_found` reselect. Replaces the previous
   * `getPermissionHelper(rc)` service-location. */
  permissionHelper?: PermissionHelper;
  /** The SQL validation boundary (syntactic DML guard + semantic judge + error
   * classifier), injected by the step. Falls back to a default instance so
   * callers/tests without the component mounted still validate. */
  sqlValidator?: SqlValidatorService;
}): Promise<SqlAttemptResult> {
  const sqlValidator = args.sqlValidator ?? new SqlValidatorService();
  const stage = await runGenerationStage(args);
  if (stage.error) {
    logStepDetail(
      LABEL_SQL_GENERATION,
      `SQL generation failed: ${stage.error}`,
    );
    return {sql: stage.sql, passed: false, feedback: stage.error};
  }
  logStepDetail(LABEL_SQL_GENERATION, `Generated SQL query: ${stage.sql}`);
  const verdict = await runValidationStage({
    sql: stage.sql,
    chatLlm: args.chatLlm,
    dbConnector: args.dbConnector,
    prompt: args.prompt,
    checklist: args.checklist,
    checks: args.checks,
    onStatus: args.onStatus,
    tracing: args.tracing,
    lastAttempt: args.lastAttempt,
    descriptionLlm: args.descriptionLlm,
    rc: args.rc,
    sqlValidator,
  });
  if (!verdict.passed) {
    logStepDetail(
      'sql-validation',
      `Query validation failed (${verdict.kind}): ${verdict.feedback ?? ''}`,
    );
  }
  const tables =
    !verdict.passed && verdict.kind === 'syntactic'
      ? await expandTablesOnTableError({
          chatLlm: args.cheapLlm ?? args.chatLlm,
          error: verdict.feedback ?? '',
          sql: stage.sql,
          currentTables: args.tables,
          allTables: args.allTables,
          tracing: args.tracing,
          permissionHelper:
            args.permissionHelper ?? getPermissionHelper(args.rc),
          onReselectTables: args.onReselectTables,
          sqlValidator,
        })
      : undefined;
  return {
    sql: stage.sql,
    passed: verdict.passed,
    feedback: verdict.feedback,
    // Prefer the streamed natural-language description; fall back to the
    // static one from the generation stage when description streaming is off.
    description: verdict.description ?? stage.description,
    tables,
  };
}

/**
 * Classify a syntactic failure and, when it is `table_not_found`, return the
 * widened allowed-table set (current ∪ related-tables-that-exist-in-schema).
 * Returns `undefined` when there is nothing to expand, so the caller leaves
 * the table set unchanged and just fixes the SQL with feedback. Mirrors v2's
 * PostValidation `ReselectTables` branch seeded with `syntacticErrorTables`.
 */
async function expandTablesOnTableError(args: {
  chatLlm: LanguageModel | undefined;
  error: string;
  sql: string;
  currentTables: string[];
  allTables?: string[];
  tracing?: TracingContext;
  permissionHelper?: PermissionHelper;
  onReselectTables?: (mergedTables: string[]) => void;
  sqlValidator: SqlValidatorService;
}): Promise<string[] | undefined> {
  const allTables = args.allTables;
  if (!allTables?.length) return undefined;
  const {category, errorTables} = await args.sqlValidator.classifyError({
    chatLlm: args.chatLlm,
    error: args.error,
    sql: args.sql,
    allTables,
    tracing: args.tracing,
  });
  if (category !== 'table_not_found' || errorTables.length === 0) {
    return undefined;
  }
  const allowed = new Set(allTables);
  const merged = filterTablesByPermission(
    [
      ...new Set([
        ...args.currentTables,
        ...errorTables.filter(t => allowed.has(t)),
      ]),
    ],
    args.permissionHelper,
  );
  if (merged.length <= args.currentTables.length) return undefined;
  logStepDetail('sql-validation', `Reselected tables: ${merged.join(', ')}`);
  args.onReselectTables?.(merged);
  return merged;
}

/**
 * Single LLM call producing the next SQL candidate. Caller picks the
 * prompt skeleton (generate vs improve) and forwards the chat model.
 * Returns {sql, error?}; error is set when the LLM call rejects.
 */
export async function generateSqlOnce(
  chatLlm: LanguageModel,
  promptTemplate: string,
  tracing?: TracingContext,
): Promise<{sql: string; error?: string}> {
  try {
    const result = await tracedGenerateText({
      model: chatLlm,
      prompt: promptTemplate,
      tracing,
      label: LABEL_SQL_GENERATION,
      resultType: 'planning',
    });
    return {sql: stripSqlFences(result.text)};
  } catch (err) {
    return {sql: '', error: (err as Error).message};
  }
}

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
 * One-shot column-relevance LLM call for getColumnsStep. Returns the
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

/**
 * Full list of table names in the loaded schema; `[]` when the SchemaStore
 * is unbound or the schema isn't loaded yet. Used to scope the
 * `table_not_found` reclassification to tables that actually exist.
 */
export function getAllSchemaTables(
  schemaStore: SchemaStore | undefined,
): string[] {
  if (!schemaStore) return [];
  try {
    return Object.keys(schemaStore.get().tables);
  } catch {
    return [];
  }
}

/**
 * Read SchemaStore.filteredSchema(tables) into a {table: columns[]}
 * blob; returns {} when the SchemaStore is unbound or schema is empty.
 */
export function getTablesWithColumns(
  schemaStore: SchemaStore | undefined,
  tables: string[],
): Record<string, string[]> {
  if (!schemaStore) return {};
  try {
    const schema = schemaStore.filteredSchema(tables);
    const out: Record<string, string[]> = {};
    for (const [tableName, tableDef] of Object.entries(schema.tables)) {
      out[tableName] = Object.keys(
        (tableDef as {columns?: Record<string, unknown>}).columns ?? {},
      );
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Build the RICH schema text for the SQL-gen prompt — the v2 representation
 * (`connector.toDDL(schema)`): CREATE TABLE blocks with column descriptions as
 * `-- comments`, `FOREIGN KEY` constraints (so the model sees how tables link),
 * and the table description. `toDDL` does NOT emit the per-table `context`
 * array, so it is appended as `-- [table] rule` lines. Returns `undefined`
 * (caller falls back to the bare name list) when a binding is missing or the
 * filtered schema is empty.
 *
 * This restores what the thin Mastra rewrite dropped: without relations +
 * descriptions the model cannot join related tables (e.g. revenue↔deal) and
 * refuses with "no link between the tables".
 */
export function getSchemaForPrompt(
  schemaStore: SchemaStore | undefined,
  dbConnector: IDbConnector | undefined,
  tables: string[],
): string | undefined {
  if (!schemaStore || !dbConnector) return undefined;
  try {
    const filtered = schemaStore.filteredSchema(tables);
    if (!Object.keys(filtered.tables).length) return undefined;
    let ddl = dbConnector.toDDL(filtered);
    const contextLines: string[] = [];
    for (const [name, def] of Object.entries(filtered.tables)) {
      for (const line of (def as {context?: string[]}).context ?? []) {
        contextLines.push(`-- [${name}] ${line}`);
      }
    }
    if (contextLines.length) {
      ddl += `\n\n-- Table rules (follow these):\n${contextLines.join('\n')}`;
    }
    return ddl;
  } catch {
    return undefined;
  }
}

/**
 * Fetch template + run TemplateHelper.resolveTemplate. Returns the
 * resolved SQL + description or `null` when any binding is missing or
 * the template helper rejects.
 */
export async function resolveTemplateById(args: {
  templateStore: IQueryTemplateStore | undefined;
  templateHelper: TemplateHelper | undefined;
  schemaStore: SchemaStore | undefined;
  templateId: string;
  prompt: string;
}): Promise<{sql: string; description?: string; tables: string[]} | null> {
  const {templateStore, templateHelper, schemaStore, templateId, prompt} = args;
  if (!templateStore || !templateHelper) return null;
  try {
    const template = await templateStore.findById(templateId);
    const schema = (() => {
      try {
        return schemaStore?.get();
      } catch {
        return undefined;
      }
    })();
    const resolved = await templateHelper.resolveTemplate(
      template,
      prompt,
      schema,
      async id => {
        try {
          return await templateStore.findById(id);
        } catch {
          return undefined;
        }
      },
    );
    // Surface the template's AUTHORITATIVE table list so the caller can
    // persist it on the dataset. The read-time ACL
    // (DataSetHelper.getDataFromDataset) checks dataset.tables; without the
    // template's own tables it would only see the get-tables guess and could
    // miss a table the template's SQL actually reads.
    return resolved.sql
      ? {
          sql: resolved.sql,
          description: resolved.description,
          tables: template.tables ?? [],
        }
      : null;
  } catch {
    return null;
  }
}

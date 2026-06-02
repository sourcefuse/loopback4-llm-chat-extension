import type {RequestContext} from '@mastra/core/request-context';
import type {MastraModelConfig} from '@mastra/core/llm';
import type {Tool} from '@mastra/core/tools';
import {SpanType} from '@mastra/core/observability';
import type {TracingContext} from '@mastra/core/observability';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {generateText} from 'ai';
import type {LanguageModel} from 'ai';
import {
  LLMStreamEventType,
  type LLMStreamEvent,
} from '../../../graphs/event.types';

/** Inferred return type of `generateText` without further constraining
 * the (tools, output) generics — used as `tracedGenerateText`'s return
 * type so callers see the same `{text, usage, ...}` shape as a direct
 * `generateText` call. */
type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>;
import type {
  DataSetHelper,
  DbSchemaHelperService,
  TemplateHelper,
} from '../../../components/db-query/services';
import type {SchemaStore} from '../../../components/db-query/services/schema.store';
import type {
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
  IQueryTemplateStore,
} from '../../../components/db-query/types';
import type {IVisualizer} from '../../../components/visualization/types';

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
  // keys (function-typed Agent params, see MastraProvider). Threading them
  // through RequestContext — instead of building a detached `new Agent()`
  // per request — keeps the agent registered with the Mastra instance so
  // its spans reach the configured observability exporter (Langfuse).
  agentModel?: MastraModelConfig;
  agentTools?: Record<string, Tool>;
  agentInstructions?: string;
  // Per-request domain rules (v2 `{checks}`) injected into the SQL
  // generation prompt — e.g. "exchange rate joins must use the active
  // rate (end_date IS NULL)", "use partial case-insensitive name match".
  // Without these the SQL generator produces literal/over-strict SQL.
  globalContext?: string[];
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
export function getDbConnector(rc?: MastraRc): IDbConnector | undefined {
  return rc?.get('dbConnector');
}
export function getAuthUser(
  rc?: MastraRc,
): IAuthUserWithPermissions | undefined {
  return rc?.get('authUser');
}
export function getDatasetStore(rc?: MastraRc): IDataSetStore | undefined {
  return rc?.get('datasetStore');
}
export function getDbQueryConfig(rc?: MastraRc): DbQueryConfig | undefined {
  return rc?.get('config');
}
export function getTemplateStore(
  rc?: MastraRc,
): IQueryTemplateStore | undefined {
  return rc?.get('templateStore');
}
export function getSchemaStore(rc?: MastraRc): SchemaStore | undefined {
  return rc?.get('schemaStore');
}
export function getSchemaHelper(
  rc?: MastraRc,
): DbSchemaHelperService | undefined {
  return rc?.get('schemaHelper');
}
export function getTemplateHelper(rc?: MastraRc): TemplateHelper | undefined {
  return rc?.get('templateHelper');
}
export function getDataSetHelper(rc?: MastraRc): DataSetHelper | undefined {
  return rc?.get('dataSetHelper');
}
export function getQueryCache(rc?: MastraRc): MastraRcShape['queryCache'] {
  return rc?.get('queryCache');
}
export function getTemplateCache(
  rc?: MastraRc,
): MastraRcShape['templateCache'] {
  return rc?.get('templateCache');
}
export function getVisualizers(rc?: MastraRc): IVisualizer[] {
  return rc?.get('visualizers') ?? [];
}
export function getGlobalContext(rc?: MastraRc): string[] {
  return rc?.get('globalContext') ?? [];
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
  const parsed = parseFloat(raw);
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
  const budgetTokens = parseInt(
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
export async function tracedGenerateText(args: {
  model: LanguageModel;
  prompt: string;
  tracing?: TracingContext;
  /** Short label used as the span name, e.g. `'cache-judge'`. */
  label: string;
  resultType?:
    | 'tool_selection'
    | 'response_generation'
    | 'reasoning'
    | 'planning';
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
    attributes: {model: modelId, provider, resultType},
  });
  const providerOptions = buildProviderOptions({forceThinkingOff});
  const temperature = resolveEnvTemperature();
  try {
    const result = await generateText({
      model,
      prompt,
      ...(temperature !== undefined ? {temperature} : {}),
      ...(providerOptions ? {providerOptions: providerOptions as never} : {}),
    });
    span?.end({
      attributes: {model: modelId, provider, resultType},
      // `end` accepts AI SDK's raw `usage` shape via EndGenerationOptions —
      // Mastra converts it to its own UsageStats.
      usage: result.usage,
    } as never);
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
  const writer = rc?.get('eventWriter');
  if (!writer) return;
  writer({
    type: LLMStreamEventType.ToolStatus,
    data: {id, status},
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

export type SqlGenInput = {
  prompt: string;
  tables: string[];
  columns?: Record<string, string[]>;
  checks?: string[];
  checklist?: string;
  feedback?: string;
  originalSql?: string;
};

function formatChecks(checks: string[] | undefined): string {
  if (!checks?.length) return '';
  const bullets = checks.map(c => `- ${c}`).join('\n');
  return `\nDomain rules you MUST follow:\n${bullets}`;
}

function formatTablesWithColumns(
  tables: string[],
  columns: Record<string, string[]> | undefined,
): string {
  if (!tables.length) return '(any)';
  if (!columns) return tables.join(', ');
  return tables
    .map(t => {
      const cols = columns[t];
      return cols?.length ? `${t}(${cols.join(', ')})` : t;
    })
    .join('; ');
}

export type SqlAttemptResult = {
  sql: string;
  passed: boolean;
  feedback?: string;
  description?: string;
};

type SqlGenStage = {sql: string; description?: string; error?: string};

async function runGenerationStage(args: {
  chatLlm: LanguageModel | undefined;
  prompt: string;
  tables: string[];
  columns?: Record<string, string[]>;
  checks?: string[];
  checklist?: string;
  feedback?: string;
  initialSql?: string;
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
      checks: args.checks,
      checklist: args.checklist,
      feedback: args.feedback,
      originalSql: args.initialSql,
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

async function runValidationStage(args: {
  sql: string;
  chatLlm: LanguageModel | undefined;
  dbConnector: IDbConnector | undefined;
  prompt: string;
  checklist?: string;
  onStatus?: (stage: 'syntactic' | 'semantic') => void;
  tracing?: TracingContext;
}): Promise<{passed: boolean; feedback?: string}> {
  const {sql} = args;
  if (!sql)
    return {passed: false, feedback: 'SQL generation produced an empty query.'};
  args.onStatus?.('syntactic');
  const syntactic = await validateSqlSyntactic(sql, args.dbConnector);
  if (!syntactic.passed) return syntactic;
  args.onStatus?.('semantic');
  return validateSqlSemantic({
    sql,
    chatLlm: args.chatLlm,
    prompt: args.prompt,
    checklist: args.checklist,
    tracing: args.tracing,
  });
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
  checks?: string[];
  checklist?: string;
  feedback?: string;
  buildPrompt: (input: SqlGenInput) => string;
  initialSql?: string;
  buildDescription?: (sql: string, prompt: string) => string;
  onStatus?: (stage: 'syntactic' | 'semantic') => void;
  tracing?: TracingContext;
}): Promise<SqlAttemptResult> {
  const stage = await runGenerationStage(args);
  if (stage.error) {
    return {sql: stage.sql, passed: false, feedback: stage.error};
  }
  const verdict = await runValidationStage({
    sql: stage.sql,
    chatLlm: args.chatLlm,
    dbConnector: args.dbConnector,
    prompt: args.prompt,
    checklist: args.checklist,
    onStatus: args.onStatus,
    tracing: args.tracing,
  });
  return {
    sql: stage.sql,
    passed: verdict.passed,
    feedback: verdict.feedback,
    description: stage.description,
  };
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
      label: 'sql-generation',
      resultType: 'planning',
    });
    return {sql: stripSqlFences(result.text)};
  } catch (err) {
    return {sql: '', error: (err as Error).message};
  }
}

/**
 * Build the SQL-generation prompt used by generate.sqlAndValidateStep.
 */
export function buildGenerateSqlPrompt(input: SqlGenInput): string {
  const tablesLine = formatTablesWithColumns(input.tables, input.columns);
  const checklistLine = input.checklist ?? '(none)';
  const feedbackLine = input.feedback
    ? `Previous attempt was rejected with the following feedback that you must address: ${input.feedback}`
    : '';
  return `You are a SQL expert. Generate a single ANSI SQL query that satisfies the user's request.

User request: ${input.prompt}
Allowed tables and columns (use ONLY these column names verbatim — do not invent or rename columns): ${tablesLine}${formatChecks(input.checks)}
Validation checklist:
${checklistLine}
${feedbackLine}

Return ONLY the SQL statement. No explanation, no markdown fences, no comments.`;
}

/**
 * Build the improve-SQL prompt used by improve.fixQueryStep.
 */
export function buildImproveSqlPrompt(input: SqlGenInput): string {
  const checklistLine = input.checklist
    ? `Validation checklist:\n${input.checklist}`
    : '';
  const feedbackLine = input.feedback
    ? `Previous attempt was rejected: ${input.feedback}`
    : '';
  const tablesWithColumns = formatTablesWithColumns(
    input.tables,
    input.columns,
  );
  return `You are a SQL expert. Improve the existing SQL query to satisfy the user's new request.

Existing SQL: ${input.originalSql ?? '(none)'}
User feedback / delta request: ${input.prompt}
Allowed tables and columns (use ONLY these column names verbatim — do not invent or rename columns): ${tablesWithColumns}${formatChecks(input.checks)}
${checklistLine}
${feedbackLine}

Return ONLY the improved SQL statement. No explanation, no markdown fences, no comments.`;
}

/**
 * Run the syntactic validator (DB EXPLAIN) when an IDbConnector is
 * bound. Returns {passed: true} (treated as "no-op pass") whenever the
 * binding is missing so partial-configuration deployments still
 * complete the dountil loop after the first iteration.
 */
export async function validateSqlSyntactic(
  sql: string,
  dbConnector: IDbConnector | undefined,
): Promise<{passed: boolean; feedback?: string}> {
  if (!sql || !dbConnector) return {passed: true};
  try {
    await dbConnector.validate(sql);
    return {passed: true};
  } catch (err) {
    return {
      passed: false,
      feedback: `Syntactic error: ${(err as Error).message}`,
    };
  }
}

/**
 * Run the semantic validator (LLM `<valid/>` vs `<invalid>...</invalid>`
 * verdict against the checklist). Skipped (treated as pass) when the
 * chat model or checklist is missing.
 */
export async function validateSqlSemantic(args: {
  sql: string;
  chatLlm: LanguageModel | undefined;
  prompt: string;
  checklist?: string;
  tracing?: TracingContext;
}): Promise<{passed: boolean; feedback?: string}> {
  const {sql, chatLlm, prompt, checklist, tracing} = args;
  if (!sql || !chatLlm || !checklist) return {passed: true};
  const semanticPrompt = `You are a SQL semantic validator. Decide whether the SQL below satisfies every item in the validation checklist for the user's request.

User request: ${prompt}
SQL: ${sql}
Validation checklist:
${checklist}

If every checklist item is satisfied, return ONLY: <valid/>
Otherwise return: <invalid>one short sentence per failed item</invalid>
Do not return any other text.`;
  try {
    const verdict = await tracedGenerateText({
      model: chatLlm,
      prompt: semanticPrompt,
      tracing,
      label: 'semantic-validate',
      resultType: 'reasoning',
    });
    const text = verdict.text.trim();
    if (text.includes('<valid/>')) return {passed: true};
    const match = text.match(/<invalid>([\s\S]*?)<\/invalid>/);
    return {
      passed: false,
      feedback: `Semantic error: ${match?.[1]?.trim() ?? text}`,
    };
  } catch (err) {
    // Verdict LLM rejected. Return passed=false with retry feedback so
    // the dountil loop tries again up to MAX_VALIDATION_ATTEMPTS. The
    // post-loop branch then routes to failedStep with a real reason if
    // every attempt fails. Treating a flaky judge as PASS would let
    // wrong-result SQL persist to saveDatasetStep.
    return {
      passed: false,
      feedback: `Validator unavailable: ${(err as Error).message ?? 'unknown'}`,
    };
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
export async function pickRelevantTables(args: {
  chatLlm: LanguageModel;
  prompt: string;
  tablesWithColumns: Record<string, string[]>;
  upstreamTables: string[];
  tracing?: TracingContext;
}): Promise<string[] | null> {
  const {chatLlm, prompt, tablesWithColumns, upstreamTables, tracing} = args;
  if (Object.keys(tablesWithColumns).length === 0) return null;
  const llmPrompt = `You are an AI assistant that identifies relevant columns from database tables based on a user's query.
Return a JSON object where each table name is a key and the value is an array of relevant column names.

Tables with columns:
${JSON.stringify(tablesWithColumns, null, 2)}

User query: ${prompt}

Return ONLY valid JSON. Include primary-key and foreign-key columns even if not directly mentioned.`;
  try {
    const result = await tracedGenerateText({
      model: chatLlm,
      prompt: llmPrompt,
      tracing,
      label: 'get-columns',
      resultType: 'planning',
    });
    const cleaned = stripJsonFences(result.text);
    const parsed = JSON.parse(cleaned) as Record<string, string[]>;
    const filtered = Object.keys(parsed).filter(t =>
      upstreamTables.includes(t),
    );
    return filtered.length > 0 ? filtered : null;
  } catch {
    return null;
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
}): Promise<{sql: string; description?: string} | null> {
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
    return resolved.sql
      ? {sql: resolved.sql, description: resolved.description}
      : null;
  } catch {
    return null;
  }
}

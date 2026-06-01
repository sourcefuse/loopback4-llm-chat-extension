import type {RequestContext} from '@mastra/core/request-context';
import type {MastraModelConfig} from '@mastra/core/llm';
import type {Tool} from '@mastra/core/tools';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {generateText} from 'ai';
import type {LanguageModel} from 'ai';
import {
  LLMStreamEventType,
  type LLMStreamEvent,
} from '../../../graphs/event.types';
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
): Promise<{sql: string; error?: string}> {
  try {
    const result = await generateText({model: chatLlm, prompt: promptTemplate});
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
}): Promise<{passed: boolean; feedback?: string}> {
  const {sql, chatLlm, prompt, checklist} = args;
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
    const verdict = await generateText({
      model: chatLlm,
      prompt: semanticPrompt,
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
}): Promise<string[] | null> {
  const {chatLlm, prompt, tablesWithColumns, upstreamTables} = args;
  if (Object.keys(tablesWithColumns).length === 0) return null;
  const llmPrompt = `You are an AI assistant that identifies relevant columns from database tables based on a user's query.
Return a JSON object where each table name is a key and the value is an array of relevant column names.

Tables with columns:
${JSON.stringify(tablesWithColumns, null, 2)}

User query: ${prompt}

Return ONLY valid JSON. Include primary-key and foreign-key columns even if not directly mentioned.`;
  try {
    const result = await generateText({model: chatLlm, prompt: llmPrompt});
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

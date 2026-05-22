import type {Context} from '@loopback/core';
import type {RequestContext} from '@mastra/core/request-context';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {generateText} from 'ai';
import type {LanguageModel} from 'ai';
import {AuthenticationBindings} from 'loopback4-authentication';
import {DbQueryAIExtensionBindings} from '../../../components/db-query/keys';
import type {
  DbSchemaHelperService,
  TemplateHelper,
} from '../../../components/db-query/services';
import type {SchemaStore} from '../../../components/db-query/services/schema.store';
import type {
  IDataSetStore,
  IDbConnector,
  IQueryTemplateStore,
} from '../../../components/db-query/types';

const SCHEMA_STORE_KEY = 'services.SchemaStore';
const SCHEMA_HELPER_KEY = 'services.DbSchemaHelperService';
const TEMPLATE_HELPER_KEY = 'services.TemplateHelper';

/**
 * Shared helpers for the db-query workflows. Pulled out of inlined
 * step bodies to keep individual `createStep({execute})` blocks below
 * SonarQube's cyclomatic + cognitive complexity thresholds.
 *
 * The helpers preserve the previous defensive-fallback semantics:
 * every one returns a "safe" value when a binding / dependency is
 * missing so the workflow stays runnable in partial configurations.
 */

export function getLb4Ctx(
  rc: RequestContext<Record<string, unknown>> | undefined,
): Context | undefined {
  return rc?.get('lb4Ctx') as Context | undefined;
}

export function getChatLlm(
  rc: RequestContext<Record<string, unknown>> | undefined,
): LanguageModel | undefined {
  return rc?.get('chatLlm') as LanguageModel | undefined;
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
  checklist?: string;
  feedback?: string;
  originalSql?: string;
};

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
  lb4Ctx: Context | undefined;
  prompt: string;
  checklist?: string;
}): Promise<{passed: boolean; feedback?: string}> {
  const {sql} = args;
  if (!sql) return {passed: true};
  const syntactic = await validateSqlSyntactic(sql, args.lb4Ctx);
  if (!syntactic.passed) return syntactic;
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
  lb4Ctx: Context | undefined;
  prompt: string;
  tables: string[];
  checklist?: string;
  feedback?: string;
  buildPrompt: (input: SqlGenInput) => string;
  initialSql?: string;
  buildDescription?: (sql: string, prompt: string) => string;
}): Promise<SqlAttemptResult> {
  const stage = await runGenerationStage(args);
  if (stage.error) {
    return {sql: stage.sql, passed: false, feedback: stage.error};
  }
  const verdict = await runValidationStage({
    sql: stage.sql,
    chatLlm: args.chatLlm,
    lb4Ctx: args.lb4Ctx,
    prompt: args.prompt,
    checklist: args.checklist,
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
  const tablesLine = input.tables.length ? input.tables.join(', ') : '(any)';
  const checklistLine = input.checklist ?? '(none)';
  const feedbackLine = input.feedback
    ? `Previous attempt was rejected with the following feedback that you must address: ${input.feedback}`
    : '';
  return `You are a SQL expert. Generate a single ANSI SQL query that satisfies the user's request.

User request: ${input.prompt}
Allowed tables: ${tablesLine}
Validation checklist:
${checklistLine}
${feedbackLine}

Return ONLY the SQL statement. No explanation, no markdown fences, no comments.`;
}

/**
 * Build the improve-SQL prompt used by improve.fixQueryStep.
 */
export function buildImproveSqlPrompt(input: SqlGenInput): string {
  const tablesLine = input.tables.length ? input.tables.join(', ') : '(any)';
  const checklistLine = input.checklist
    ? `Validation checklist:\n${input.checklist}`
    : '';
  const feedbackLine = input.feedback
    ? `Previous attempt was rejected: ${input.feedback}`
    : '';
  return `You are a SQL expert. Improve the existing SQL query to satisfy the user's new request.

Existing SQL: ${input.originalSql ?? '(none)'}
User feedback / delta request: ${input.prompt}
Allowed tables: ${tablesLine}
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
  lb4Ctx: Context | undefined,
): Promise<{passed: boolean; feedback?: string}> {
  if (!lb4Ctx || !sql) return {passed: true};
  const dbConnector = await lb4Ctx.get<IDbConnector>(
    DbQueryAIExtensionBindings.Connector,
    {optional: true},
  );
  if (!dbConnector) return {passed: true};
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
  } catch {
    // Verdict LLM failed — treat as pass to avoid blocking on a flaky
    // judge model. Mastra observability captures the error span.
    return {passed: true};
  }
}

/**
 * Read the cached schema hash, returning '' when the SchemaStore is
 * unbound or empty. Extracted so saveDatasetStep + saveDatasetFromTemplateStep
 * stay simple.
 */
export async function computeSchemaHash(
  lb4Ctx: Context,
): Promise<{schemaHash: string; tablesFromSchema: string[]}> {
  const schemaHelper = await lb4Ctx.get<DbSchemaHelperService>(
    SCHEMA_HELPER_KEY,
    {optional: true},
  );
  const schemaStore = await lb4Ctx.get<SchemaStore>(SCHEMA_STORE_KEY, {
    optional: true,
  });
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
 * Resolve the bindings saveDataset / saveDatasetFromTemplate need
 * together. Any missing dep produces a `null` so callers can short-
 * circuit to the inert default without dragging defensive ?. through
 * the body.
 */
export async function resolvePersistDeps(lb4Ctx: Context): Promise<{
  store: IDataSetStore;
  user: IAuthUserWithPermissions & {tenantId: string};
} | null> {
  const store = await lb4Ctx.get<IDataSetStore>(
    DbQueryAIExtensionBindings.DatasetStore,
    {optional: true},
  );
  const user = await lb4Ctx.get<IAuthUserWithPermissions>(
    AuthenticationBindings.CURRENT_USER,
    {optional: true},
  );
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
export async function getTablesWithColumns(
  lb4Ctx: Context,
  tables: string[],
): Promise<Record<string, string[]>> {
  const schemaStore = await lb4Ctx.get<SchemaStore>(SCHEMA_STORE_KEY, {
    optional: true,
  });
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
  lb4Ctx: Context;
  templateId: string;
  prompt: string;
}): Promise<{sql: string; description?: string} | null> {
  const {lb4Ctx, templateId, prompt} = args;
  const templateStore = await lb4Ctx.get<IQueryTemplateStore>(
    DbQueryAIExtensionBindings.TemplateStore,
    {optional: true},
  );
  const templateHelper = await lb4Ctx.get<TemplateHelper>(TEMPLATE_HELPER_KEY, {
    optional: true,
  });
  const schemaStore = await lb4Ctx.get<SchemaStore>(SCHEMA_STORE_KEY, {
    optional: true,
  });
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
      {} as never,
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

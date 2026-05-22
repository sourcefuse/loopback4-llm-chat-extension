import type {Context} from '@loopback/core';
import type {RequestContext} from '@mastra/core/request-context';
import {generateText} from 'ai';
import type {LanguageModel} from 'ai';
import {DbQueryAIExtensionBindings} from '../../../components/db-query/keys';
import type {IDbConnector} from '../../../components/db-query/types';

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

/**
 * Strip leading ```sql / ``` fences and trailing ``` plus whitespace.
 * Pure string ops to avoid super-linear regex backtracking (s5852).
 */
export function stripSqlFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```sql')) {
    s = s.slice('```sql'.length);
  } else if (s.startsWith('```')) {
    s = s.slice('```'.length);
  }
  if (s.endsWith('```')) {
    s = s.slice(0, -3);
  }
  return s.trim();
}

export type SqlGenInput = {
  prompt: string;
  tables: string[];
  checklist?: string;
  feedback?: string;
  originalSql?: string;
};

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

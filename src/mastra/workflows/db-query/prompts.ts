// SQL-generation prompt building, extracted from _helpers.ts (kept under the
// 1000-line limit, SonarQube S104). Pure string assembly — no Mastra/runtime
// deps. Re-exported from _helpers so existing import sites are unaffected.

export type SqlGenInput = {
  prompt: string;
  tables: string[];
  columns?: Record<string, string[]>;
  /**
   * Rich schema text (DDL with column descriptions + FOREIGN KEY relations +
   * per-table context), built via {@link getSchemaForPrompt}. When present it
   * REPLACES the bare `tables(columns)` line in the prompt — the model needs
   * the relations + descriptions to know how tables link and what enum/status
   * columns mean (v2 passed `connector.toDDL(schema)`; the thin Mastra rewrite
   * had dropped it to column names only, so multi-table joins like
   * revenue↔deal failed with "no link between the tables").
   */
  schema?: string;
  checks?: string[];
  checklist?: string;
  feedback?: string;
  originalSql?: string;
  // A user-validated query from the cache judged "Similar" to this request,
  // shown to the model as a worked example (restores v2 sampleSql/Prompt).
  sampleSql?: string;
  samplePrompt?: string;
};

/**
 * Render the "similar validated example" block for the SQL-gen prompt
 * (v2 sql-generation.node `<similar-example-query>`). Empty when no sample.
 */
export function formatSampleExample(input: SqlGenInput): string {
  if (!input.sampleSql) return '';
  const forQuestion = input.samplePrompt
    ? `\nThis was generated for the following question:\n${input.samplePrompt}`
    : '';
  return `\n<similar-example-query>
Here is an example query for reference that is similar to the question asked and has been validated by the user:
${input.sampleSql}${forQuestion}
</similar-example-query>`;
}

export function formatChecks(checks: string[] | undefined): string {
  if (!checks?.length) return '';
  const bullets = checks.map(c => `- ${c}`).join('\n');
  return `\nDomain rules you MUST follow:\n${bullets}`;
}

export function formatTablesWithColumns(
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

/**
 * Build the SQL-generation prompt used by generate.sqlAndValidateStep.
 */
export function buildGenerateSqlPrompt(input: SqlGenInput): string {
  // Prefer the rich schema (DDL + relations + per-table context) so the model
  // can see how tables link and what columns mean; fall back to the bare
  // name list only when no schema text was supplied.
  const tablesLine =
    input.schema ?? formatTablesWithColumns(input.tables, input.columns);
  const checklistLine = input.checklist ?? '(none)';
  const feedbackLine = input.feedback
    ? `Previous attempt was rejected with the following feedback that you must address: ${input.feedback}`
    : '';
  // Ports the v2 LangGraph sql-generation.node rules — notably the explicit
  // "use JOINs, subqueries, CTEs or UNIONs" guidance (the thinner Mastra
  // rewrite had dropped it, so subquery questions like "earn more than the
  // average salary" failed validation repeatedly), plus no-DML, no-SELECT-*,
  // no-intent-assumptions, and bracket-grouping for mixed AND/OR.
  return `You are an expert AI assistant that generates a SQL query from a user question and a database schema. Deliberately read the question and the schema word by word, then write ONE query that answers it.

Rules — follow every one, do not skip any:
- Generate a SINGLE query. If you need multiple results, combine them with JOINs, subqueries, CTEs, or UNIONs.
- DO NOT write any DML statement (INSERT, UPDATE, DELETE, DROP, etc.).
- Select only the columns the question needs — never SELECT *.
- Use ONLY the table/column names listed below, verbatim — do not invent or rename columns.
- Do not make assumptions about the user intent beyond what is explicitly provided.
- When a WHERE clause mixes AND and OR, group the conditions with brackets.

User request: ${input.prompt}
Allowed tables and columns: ${tablesLine}${formatChecks(input.checks)}${formatSampleExample(input)}
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
  const tablesWithColumns =
    input.schema ?? formatTablesWithColumns(input.tables, input.columns);
  return `You are a SQL expert. Improve the existing SQL query to satisfy the user's new request.

Existing SQL: ${input.originalSql ?? '(none)'}
User feedback / delta request: ${input.prompt}
Allowed tables and columns (use ONLY these column names verbatim — do not invent or rename columns): ${tablesWithColumns}${formatChecks(input.checks)}
${checklistLine}
${feedbackLine}

Return ONLY the improved SQL statement. No explanation, no markdown fences, no comments.`;
}

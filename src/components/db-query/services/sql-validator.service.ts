import {BindingScope, injectable} from '@loopback/core';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import debugFactory from 'debug';
import type {IDbConnector} from '../types';
import {tracedGenerateText} from '../steps/_helpers';

const dbg = debugFactory('ai-integration:sql-validator');

/**
 * The read-only-SQL / validation boundary, restored as an injectable,
 * overridable service (v2/main split this across `SyntacticValidatorNode`,
 * `SemanticValidatorNode` and `ClassifyChangeNode`). A consumer rebinds
 * `services.SqlValidatorService` to change any part of the validation policy
 * — e.g. a stricter DML guard or a different semantic judge — without forking
 * the workflow.
 *
 * Stateless: TRANSIENT scope, all inputs are passed per-call.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class SqlValidatorService {
  /**
   * Return the name of the first data-modifying statement keyword found in
   * `sql` (anywhere, including inside a CTE body), or `undefined` for a
   * read-only query. Comments and string/identifier literals are stripped
   * first so a column named `update_date` or the text `'please delete'` inside
   * a literal does not trip the guard. Keyword forms are anchored to their
   * statement shape (e.g. `DELETE FROM`, `UPDATE … SET`, `INSERT INTO`) to
   * avoid matching an alias or column that merely reuses the word.
   */
  detectDml(sql: string): string | undefined {
    const stripped = sql
      // line + block comments
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // single/double-quoted and dollar-quoted literals
      .replace(/'(?:[^']|'')*'/g, " '' ")
      .replace(/"(?:[^"]|"")*"/g, ' "" ')
      .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' $$$$ ');
    const patterns: Array<[RegExp, string]> = [
      [/\bINSERT\s+INTO\b/i, 'INSERT'],
      [/\bUPDATE\b[\s\S]*?\bSET\b/i, 'UPDATE'],
      [/\bDELETE\s+FROM\b/i, 'DELETE'],
      [/\bTRUNCATE\b/i, 'TRUNCATE'],
      [
        /\bDROP\s+(?:TABLE|VIEW|INDEX|SCHEMA|DATABASE|FUNCTION|SEQUENCE|MATERIALIZED)\b/i,
        'DROP',
      ],
      [/\bALTER\s+(?:TABLE|VIEW|SCHEMA|DATABASE|SEQUENCE|INDEX)\b/i, 'ALTER'],
      [
        /\bCREATE\s+(?:TABLE|VIEW|INDEX|SCHEMA|DATABASE|FUNCTION|SEQUENCE|MATERIALIZED|TEMP|TEMPORARY)\b/i,
        'CREATE',
      ],
      [/\bMERGE\s+INTO\b/i, 'MERGE'],
      [/\bGRANT\b/i, 'GRANT'],
      [/\bREVOKE\b/i, 'REVOKE'],
      [/\bCOPY\b/i, 'COPY'],
      [/\b(?:CALL|DO)\s/i, 'CALL'],
    ];
    for (const [re, name] of patterns) {
      if (re.test(stripped)) return name;
    }
    return undefined;
  }

  /**
   * Run the syntactic validator (DB EXPLAIN) when an IDbConnector is
   * bound. Returns {passed: true} (treated as "no-op pass") whenever the
   * binding is missing so partial-configuration deployments still
   * complete the dountil loop after the first iteration.
   */
  async validateSyntactic(
    sql: string,
    dbConnector: IDbConnector | undefined,
  ): Promise<{passed: boolean; feedback?: string}> {
    if (!sql || !dbConnector) return {passed: true};
    // Defence-in-depth read-only guard. The generation prompt instructs the
    // model to emit read-only SQL and the connector wraps execution in
    // `SELECT * FROM (<sql>) AS subquery`, which already rejects a bare
    // INSERT/UPDATE/DELETE. But a *data-modifying CTE*
    // (`WITH d AS (DELETE ... RETURNING *) SELECT * FROM d`) survives that wrap
    // and would execute, and EXPLAIN does not run it — so prompt rules are not
    // an enforcement boundary. Reject anything that contains a data-modifying
    // statement before it is ever validated/persisted/executed.
    const dml = this.detectDml(sql);
    if (dml) {
      return {
        passed: false,
        feedback: `Only read-only SELECT queries are allowed; found a ${dml} statement. Rewrite as a SELECT.`,
      };
    }
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
  async validateSemantic(args: {
    sql: string;
    chatLlm: LanguageModel | undefined;
    prompt: string;
    checklist?: string;
    tracing?: TracingContext;
  }): Promise<{passed: boolean; feedback?: string}> {
    const {sql, chatLlm, prompt, checklist, tracing} = args;
    if (!sql || !chatLlm || !checklist) return {passed: true};
    // Bias toward ACCEPT. The syntactic validator (DB EXPLAIN) has already
    // confirmed the SQL parses + runs against the real schema; this LLM judge
    // only guards against the query answering the wrong question. A judge that
    // nitpicks valid SQL forces the dountil to burn every attempt and the run
    // ends in `failed` with an empty dataset — the exact false-rejection that
    // made simple prompts return nothing. So: reject ONLY on a clear, concrete
    // violation; default to valid when unsure.
    const semanticPrompt = `You are a lenient SQL reviewer. The SQL has already passed syntax + schema checks. Your ONLY job is to catch SQL that clearly answers a DIFFERENT question than the user asked.

User request: ${prompt}
SQL: ${sql}
Constraints and domain rules the query must satisfy:
${checklist}

Return ONLY <valid/> unless the SQL CLEARLY and DEFINITELY violates one of the constraints/rules above (e.g. filters the wrong column, ignores a stated filter, breaks a domain rule). Ignore stylistic choices, column aliases, extra returned columns, ordering, and anything not listed above. When in any doubt, return <valid/>.
If — and only if — there is a clear violation, return: <invalid>one short sentence naming the violated constraint</invalid>
No other text.`;
    try {
      const verdict = await tracedGenerateText({
        model: chatLlm,
        prompt: semanticPrompt,
        tracing,
        label: 'semantic-validate',
        resultType: 'reasoning',
      });
      const text = verdict.text.trim();
      // Default to PASS: only reject on an explicit, parseable <invalid> verdict.
      const match = text.match(/<invalid>([\s\S]*?)<\/invalid>/);
      const reason = match?.[1]?.trim();
      if (reason) {
        return {passed: false, feedback: `Semantic error: ${reason}`};
      }
      return {passed: true};
    } catch (err) {
      // The judge is best-effort — syntactic validation already proved the SQL
      // runs. A flaky/unavailable judge must NOT fail otherwise-valid SQL (that
      // produced empty datasets for simple prompts). Pass; log for visibility.
      dbg('semantic-validate judge unavailable, passing: %o', err);
      return {passed: true};
    }
  }

  /**
   * Categorise a DB validation (EXPLAIN) failure and extract the tables
   * related to it. Faithful port of v2's `SyntacticValidatorNode` classifier
   * (`git show origin/main:src/components/db-query/nodes/syntactic-validator.node.ts`):
   * a cheap LLM call labels the error `table_not_found` (a missing table/column
   * — the table-selection step picked too few tables) or `query_error` (tables
   * are fine, the SQL just needs fixing) and lists ALL related tables.
   *
   * v2 then routed `table_not_found` to ReselectTables (re-run GetTables seeded
   * with the error tables = a WIDER candidate set) and `query_error` to FixQuery.
   * In the Mastra dountil model the caller (`SqlGenerationHelper.runAttempt`) merges the returned
   * tables into the allowed set for the next iteration — same effect.
   *
   * Fail-safe: returns `{category: 'query_error', errorTables: []}` whenever the
   * LLM is unbound or the verdict is unparseable, so the loop falls back to the
   * existing fix-SQL-with-feedback behaviour (no expansion) rather than erroring.
   */
  async classifyError(args: {
    chatLlm: LanguageModel | undefined;
    error: string;
    sql: string;
    allTables: string[];
    tracing?: TracingContext;
  }): Promise<{
    category: 'table_not_found' | 'query_error';
    errorTables: string[];
  }> {
    const {chatLlm, error, sql, allTables, tracing} = args;
    const fallback = {category: 'query_error' as const, errorTables: []};
    if (!chatLlm || !error || allTables.length === 0) return fallback;
    const prompt = `You are an AI assistant that categorizes the SQL query error and identifies related tables.

Here is the SQL query error that you need to categorize -
${error}

Here is the query that resulted in the error -
${sql}

Here are all the available tables in the database -
${allTables.join(', ')}

Categorize the error into one of these two categories:
- table_not_found: Any error that indicates a table or column is missing
- query_error: All other errors

Also identify ALL tables that are related to the error. Be generous - include tables that are directly involved in the error, tables referenced in the failing part of the query, and tables that might need to be joined or referenced to fix the error. It is better to include extra tables than to miss any.

Return your response in exactly this format with no other text:
<category>table_not_found or query_error</category>
<tables>comma, separated, table, names</tables>`;
    try {
      const verdict = await tracedGenerateText({
        model: chatLlm,
        prompt,
        tracing,
        label: 'classify-sql-error',
        resultType: 'reasoning',
      });
      const text = verdict.text;
      const categoryMatch = /<category>([\s\S]*?)<\/category>/.exec(text);
      const tablesMatch = /<tables>([\s\S]*?)<\/tables>/.exec(text);
      const category =
        categoryMatch?.[1]?.trim() === 'table_not_found'
          ? ('table_not_found' as const)
          : ('query_error' as const);
      const errorTables = tablesMatch
        ? tablesMatch[1]
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        : [];
      return {category, errorTables};
    } catch (err) {
      dbg(
        'classify-sql-error judge unavailable, defaulting to query_error: %o',
        err,
      );
      return fallback;
    }
  }
}

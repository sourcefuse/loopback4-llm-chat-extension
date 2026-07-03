import {BindingScope, injectable, service} from '@loopback/core';
import {SpanType} from '@mastra/core/observability';
import type {TracingContext} from '@mastra/core/observability';
import {streamText} from 'ai';
import type {LanguageModel} from 'ai';
import {
  emitThinkingToken,
  getPermissionHelper,
  logStepDetail,
  stripSqlFences,
  tracedGenerateText,
} from '../steps/_helpers';
import type {MastraRc, SqlAttemptResult} from '../steps/_helpers';
import {LABEL_SQL_GENERATION} from '../steps/constants';
import {formatChecks} from '../steps/prompts';
import type {SqlGenInput} from '../steps/prompts';
import type {IDbConnector} from '../types';
import type {PermissionHelper} from './permission-helper.service';
import {SqlValidatorService} from './sql-validator.service';

type SqlGenStage = {sql: string; description?: string; error?: string};

/**
 * The SQL generate -> validate -> retry engine, restored as an injectable,
 * overridable service (moved out of the free-function `_helpers` file so it
 * is DI/overridable and shared by SqlAndValidateStep and FixQueryStep — see
 * `runAttempt`, both steps' single call site).
 *
 * Stateless: TRANSIENT scope, all inputs are passed per-call.
 */
@injectable({scope: BindingScope.TRANSIENT})
export class SqlGenerationHelper {
  constructor(
    @service(SqlValidatorService, {optional: true})
    private readonly sqlValidator: SqlValidatorService = new SqlValidatorService(),
  ) {}

  /**
   * Run one full SQL attempt: generation -> syntactic validation ->
   * semantic validation. Returns the final attempt result with passed
   * flag + optional feedback to feed back into the dountil loop.
   */
  async runAttempt(args: {
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
  }): Promise<SqlAttemptResult> {
    const stage = await this.runGenerationStage(args);
    if (stage.error) {
      logStepDetail(
        LABEL_SQL_GENERATION,
        `SQL generation failed: ${stage.error}`,
      );
      return {sql: stage.sql, passed: false, feedback: stage.error};
    }
    logStepDetail(LABEL_SQL_GENERATION, `Generated SQL query: ${stage.sql}`);
    const verdict = await this.runValidationStage({
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
      sqlValidator: this.sqlValidator,
    });
    if (!verdict.passed) {
      logStepDetail(
        'sql-validation',
        `Query validation failed (${verdict.kind}): ${verdict.feedback ?? ''}`,
      );
    }
    const tables = await this.resolveReselectedTables(
      args,
      verdict,
      stage.sql,
      this.sqlValidator,
    );
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

  private async runGenerationStage(args: {
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
    const gen = await this.generateSqlOnce(
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

  private buildDescriptionPrompt(
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
  private stripThinkTags(text: string): string {
    // Paired blocks: anchored by both literal tags → linear, no backtracking.
    const paired = text.replace(
      /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g,
      '',
    );
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
  private deltaText(part: unknown): string {
    const p = part as {type?: string; text?: string; textDelta?: string};
    if (p.type !== 'text-delta' && p.type !== 'reasoning-delta') return '';
    return p.text ?? p.textDelta ?? '';
  }

  /** Drain a streamText fullStream, emit each delta as a thinkingToken, and
   * return the accumulated text. Extracted from {@link streamDescription} to
   * keep both functions under the complexity limit. */
  private async pumpThinking(
    stream: AsyncIterable<unknown>,
    rc: MastraRc | undefined,
  ): Promise<string> {
    let out = '';
    for await (const part of stream) {
      const token = this.deltaText(part);
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
  private async streamDescription(args: {
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
    const descriptionPrompt = this.buildDescriptionPrompt(prompt, sql, checks);
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
      const out = await this.pumpThinking(result.fullStream, rc);
      span?.end({
        output: this.stripThinkTags(out),
        // Usage inside `attributes` (Mastra reads `attributes.usage`); a
        // top-level `usage:` is ignored → 0 tokens on the span.
        attributes: {model: modelId, provider, usage: await result.usage},
      });
      return this.stripThinkTags(out);
    } catch (err) {
      span?.error({error: err as Error});
      return '';
    }
  }

  private async runValidationStage(args: {
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
      this.streamDescription({
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
   * On a syntactic failure, ask {@link expandTablesOnTableError} for a widened
   * table set (a `table_not_found` reselect). Extracted from runAttempt so
   * that function stays under the cyclomatic-complexity cap (S1541); returns
   * undefined (no change) for a pass or a non-syntactic failure.
   */
  private async resolveReselectedTables(
    args: {
      cheapLlm?: LanguageModel;
      chatLlm: LanguageModel | undefined;
      tables: string[];
      allTables?: string[];
      tracing?: TracingContext;
      permissionHelper?: PermissionHelper;
      rc?: MastraRc;
      onReselectTables?: (mergedTables: string[]) => void;
    },
    verdict: {
      passed: boolean;
      kind?: 'syntactic' | 'semantic';
      feedback?: string;
    },
    sql: string,
    sqlValidator: SqlValidatorService,
  ): Promise<string[] | undefined> {
    if (verdict.passed || verdict.kind !== 'syntactic') return undefined;
    return this.expandTablesOnTableError({
      chatLlm: args.cheapLlm ?? args.chatLlm,
      error: verdict.feedback ?? '',
      sql,
      currentTables: args.tables,
      allTables: args.allTables,
      tracing: args.tracing,
      permissionHelper: args.permissionHelper ?? getPermissionHelper(args.rc),
      onReselectTables: args.onReselectTables,
      sqlValidator,
    });
  }

  /**
   * Classify a syntactic failure and, when it is `table_not_found`, return the
   * widened allowed-table set (current ∪ related-tables-that-exist-in-schema).
   * Returns `undefined` when there is nothing to expand, so the caller leaves
   * the table set unchanged and just fixes the SQL with feedback. Mirrors v2's
   * PostValidation `ReselectTables` branch seeded with `syntacticErrorTables`.
   */
  private async expandTablesOnTableError(args: {
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
    const candidate = [
      ...new Set([
        ...args.currentTables,
        ...errorTables.filter(t => allowed.has(t)),
      ]),
    ];
    // Fail-open when no PermissionHelper is bound (partial-config deployments).
    const merged =
      args.permissionHelper?.filterAuthorizedTables(candidate) ?? candidate;
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
  private async generateSqlOnce(
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
}

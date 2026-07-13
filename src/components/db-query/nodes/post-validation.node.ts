import {inject} from '@loopback/core';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {PermissionHelper} from '../services/permission-helper.service';
import type {SchemaStore} from '../services/schema.store';
import {SqlGenerationHelper} from '../services/sql-generation.service';
import {SqlValidatorService} from '../services/sql-validator.service';
import {emitToolStatus} from '../_helpers';
import {MAX_VALIDATION_ATTEMPTS} from '../constants';
import {DbQueryNodes} from '../nodes.enum';
import type {SqlLoopState} from './sql-generation.node';

interface Verdict {
  passed: boolean;
  feedback?: string;
}

/**
 * Fan-in merge after the parallel validators + description (the Mastra
 * successor of the LangGraph inline `PostValidation` node). Combines the
 * syntactic + semantic verdicts (syntactic is authoritative; the semantic judge
 * is advisory and skipped on the final attempt so executable SQL is never lost),
 * runs the `table_not_found` reselect (v2 `ReselectTables`), and emits the
 * loop-carry state the `.dountil` checks. Reads the upstream steps via
 * `getStepResult` (same pattern as PostCacheAndTablesNode). DI-resolved,
 * overridable.
 */
@graphNode(DbQueryNodes.PostValidation)
export class PostValidationNode implements IGraphNode {
  constructor(
    @inject('services.SchemaStore', {optional: true})
    protected readonly schemaStore?: SchemaStore,
    @inject('services.PermissionHelper', {optional: true})
    protected readonly permissionHelper?: PermissionHelper,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
    @inject('services.SqlGenerationHelper', {optional: true})
    protected readonly sqlGen: SqlGenerationHelper = new SqlGenerationHelper(),
    @inject('services.SqlValidatorService', {optional: true})
    protected readonly sqlValidator: SqlValidatorService = new SqlValidatorService(),
  ) {}

  async execute({getStepResult, requestContext, tracingContext}: GraphNodeCtx) {
    const gen = (getStepResult(DbQueryNodes.SqlGeneration) ??
      {}) as SqlLoopState;

    // Cached / unanswerable short-circuit — SqlGenerationNode already set
    // `passed`; pass the state straight through so the loop exits.
    if (gen.skip) {
      return this.finalState(gen, gen.passed ?? false, gen.feedback);
    }
    if (gen.genError) {
      return this.finalState(gen, false, gen.genError);
    }

    const syntactic = this.readVerdict(
      getStepResult(DbQueryNodes.SyntacticValidator),
      'syntactic',
    );
    const semantic = this.readVerdict(
      getStepResult(DbQueryNodes.SemanticValidator),
      'semantic',
    );
    const description =
      (
        getStepResult(DbQueryNodes.GenerateDescription) as {
          description?: string;
        }
      )?.description ?? '';

    const lastAttempt = (gen.attempts ?? 0) >= MAX_VALIDATION_ATTEMPTS;
    const {verdict, kind} = this.decideVerdict(
      syntactic,
      semantic,
      lastAttempt,
    );

    if (!verdict.passed) {
      emitToolStatus(
        requestContext,
        DbQueryNodes.PostValidation,
        'Reselecting tables to resolve a missing table or column',
      );
    }

    const tables = await this.reselectTables(
      gen,
      verdict,
      kind,
      tracingContext,
    );

    return this.finalState(
      {...gen, tables, description},
      verdict.passed,
      verdict.feedback,
    );
  }

  /**
   * Pick the authoritative verdict: syntactic failure wins (the SQL won't run);
   * otherwise the semantic judge decides — except on the last attempt, where
   * syntactically-valid SQL is accepted regardless (v2 lastAttempt rule).
   * Extracted from `execute` to keep it under the complexity cap (S1541).
   */
  protected decideVerdict(
    syntactic: Verdict,
    semantic: Verdict,
    lastAttempt: boolean,
  ): {verdict: Verdict; kind?: 'syntactic' | 'semantic'} {
    if (!syntactic.passed) return {verdict: syntactic, kind: 'syntactic'};
    if (lastAttempt) return {verdict: {passed: true}};
    return {verdict: semantic, kind: 'semantic'};
  }

  /**
   * On a syntactic table_not_found, widen the allowed table set for the next
   * iteration (v2 ReselectTables → GetTables); delegates to the service.
   * Extracted from `execute` to keep it under the complexity cap (S1541).
   */
  protected async reselectTables(
    gen: SqlLoopState,
    verdict: Verdict,
    kind: 'syntactic' | 'semantic' | undefined,
    tracing?: TracingContext,
  ): Promise<string[]> {
    return (
      (await this.sqlGen.resolveReselectedTables(
        {
          cheapLlm: this.cheapModel ?? this.chatModel,
          chatLlm: this.chatModel,
          tables: gen.tables ?? [],
          allTables: this.schemaStore?.allTableNames() ?? [],
          tracing,
          permissionHelper: this.permissionHelper,
        },
        {passed: verdict.passed, kind, feedback: verdict.feedback},
        gen.sql ?? '',
        this.sqlValidator,
      )) ??
      gen.tables ??
      []
    );
  }

  protected readVerdict(raw: unknown, key: 'syntactic' | 'semantic'): Verdict {
    const v = (raw as Record<string, Verdict> | undefined)?.[key];
    return v ?? {passed: true};
  }

  /** Shape the loop-carry / terminal state (matches the generate outputSchema). */
  protected finalState(
    state: SqlLoopState,
    passed: boolean,
    feedback?: string,
  ) {
    return {
      sql: state.sql ?? '',
      passed,
      attempts: state.attempts ?? 0,
      feedback,
      description: state.description ?? '',
      prompt: state.prompt ?? '',
      tables: state.tables ?? [],
      checklist: state.checklist ?? '',
      cached: state.cached,
      datasetId: state.datasetId,
      unanswerable: state.unanswerable,
      replyToUser: state.replyToUser,
      sampleSql: state.sampleSql,
      samplePrompt: state.samplePrompt,
    };
  }
}

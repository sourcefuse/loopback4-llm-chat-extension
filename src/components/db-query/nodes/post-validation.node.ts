import {inject, service} from '@loopback/core';
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
    @service(SqlGenerationHelper, {optional: true})
    protected readonly sqlGen: SqlGenerationHelper = new SqlGenerationHelper(),
    @service(SqlValidatorService, {optional: true})
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

    // Syntactic failure is authoritative (the SQL won't run). Otherwise the
    // semantic judge decides — except on the last attempt, where syntactically
    // valid SQL is accepted regardless (v2 lastAttempt rule).
    let verdict: Verdict;
    let kind: 'syntactic' | 'semantic' | undefined;
    if (!syntactic.passed) {
      verdict = syntactic;
      kind = 'syntactic';
    } else if (lastAttempt) {
      verdict = {passed: true};
    } else {
      verdict = semantic;
      kind = 'semantic';
    }

    if (!verdict.passed) {
      emitToolStatus(
        requestContext,
        DbQueryNodes.PostValidation,
        'Reselecting tables to resolve a missing table or column',
      );
    }

    // On a syntactic table_not_found, widen the allowed table set for the next
    // iteration (v2 ReselectTables → GetTables). Delegates to the service.
    const tables =
      (await this.sqlGen.resolveReselectedTables(
        {
          cheapLlm: this.cheapModel ?? this.chatModel,
          chatLlm: this.chatModel,
          tables: gen.tables ?? [],
          allTables: this.schemaStore?.allTableNames() ?? [],
          tracing: tracingContext,
          permissionHelper: this.permissionHelper,
        },
        {passed: verdict.passed, kind, feedback: verdict.feedback},
        gen.sql ?? '',
        this.sqlValidator,
      )) ?? gen.tables;

    return this.finalState(
      {...gen, tables, description},
      verdict.passed,
      verdict.feedback,
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

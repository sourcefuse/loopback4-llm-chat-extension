import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {SchemaStore} from '../services/schema.store';
import {SqlGenerationHelper} from '../services/sql-generation.service';
import type {DbQueryConfig, IDbConnector} from '../types';
import {ChangeType} from '../types';
import {
  buildGenerateSqlPrompt,
  emitToolStatus,
  type SqlGenInput,
} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Generate one SQL candidate per loop iteration (the Mastra successor of the
 * LangGraph `SqlGenerationNode`). Owns prompt construction (the overridable
 * `buildPrompt` seam), cheap-vs-smart tier selection (v2 cost optimisation +
 * `ClassifyChangeNode`'s `changeType`), and the cached / unanswerable
 * short-circuits. Delegates the actual LLM call to the injectable, overridable
 * `SqlGenerationHelper`. Its output flows to the parallel validators.
 *
 * A host can `extends SqlGenerationNode` and override `buildPrompt` (change the
 * dialect / house style) or `shouldUseCheapForSqlGen` (the tier policy), then
 * rebind under `@graphNode(DbQueryNodes.SqlGeneration)`.
 */
@graphNode(DbQueryNodes.SqlGeneration)
export class SqlGenerationNode implements IGraphNode {
  constructor(
    @inject(DbQueryAIExtensionBindings.Connector, {optional: true})
    protected readonly dbConnector?: IDbConnector,
    @inject('services.SchemaStore', {optional: true})
    protected readonly schemaStore?: SchemaStore,
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    protected readonly config?: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    protected readonly globalContext: string[] = [],
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
    @inject(AiIntegrationBindings.SmartModel, {optional: true})
    protected readonly smartModel?: LanguageModel,
    @inject('services.SqlGenerationHelper', {optional: true})
    protected readonly sqlGen: SqlGenerationHelper = new SqlGenerationHelper(),
  ) {}

  async execute({inputData, requestContext, tracingContext}: GraphNodeCtx) {
    const data = inputData as SqlLoopState;

    // Cached "AsIs"/"Similar" passthrough — the query already exists, skip
    // generation + validation for the rest of the loop body.
    if (data.cached && data.datasetId) {
      return {
        ...data,
        skip: true,
        passed: true,
        attempts: (data.attempts ?? 0) + 1,
      };
    }
    // The get-columns gate judged the question unanswerable — carry the flag so
    // the merge exits the loop and routes to `failed`.
    if (data.unanswerable) {
      return {
        ...data,
        skip: true,
        passed: false,
        sql: '',
        attempts: (data.attempts ?? 0) + 1,
      };
    }

    emitToolStatus(
      requestContext,
      DbQueryNodes.SqlGeneration,
      'Generating SQL query from the prompt',
    );

    const tables = data.tables ?? [];
    const priorAttempts = data.attempts ?? 0;
    const store = this.schemaStore;
    const stage = await this.sqlGen.runGenerationStage({
      chatLlm: this.pickGenLlm(tables.length, priorAttempts, data.changeType),
      prompt: data.prompt ?? '',
      tables,
      columns: store?.tablesWithColumns(tables) ?? {},
      schema: store?.schemaForPrompt(this.dbConnector, tables),
      checks: this.globalContext,
      checklist: data.checklist,
      feedback: data.feedback,
      sampleSql: data.sampleSql,
      samplePrompt: data.samplePrompt,
      buildPrompt: input => this.buildPrompt(input),
      tracing: tracingContext,
    });

    return {
      ...data,
      skip: false,
      sql: stage.sql,
      genError: stage.error,
      attempts: priorAttempts + 1,
    };
  }

  /**
   * Build the SQL-generation prompt. Overridable seam restoring the v2
   * `SqlGenerationNode` prompt fields — delegates to the shared builder.
   */
  protected buildPrompt(input: SqlGenInput): string {
    return buildGenerateSqlPrompt(input);
  }

  /**
   * Cheap tier when: a validation-fix retry, a single-table query, or a `minor`
   * change (v2 `ChangeType.Minor`). Multi-table first attempts use smart.
   * Public + overridable (restores v2 SqlGenerationNode tier logic).
   */
  shouldUseCheapForSqlGen(
    tableCount: number,
    priorAttempts: number,
    changeType?: ChangeType,
  ): boolean {
    if (priorAttempts > 0) return true;
    if (changeType === ChangeType.Minor) return true;
    const forceSmartSingle =
      this.config?.nodes?.sqlGenerationNode
        ?.useSmartLLMForSingleTableQueries === true;
    return tableCount <= 1 && !forceSmartSingle;
  }

  protected pickGenLlm(
    tableCount: number,
    priorAttempts: number,
    changeType?: ChangeType,
  ): LanguageModel | undefined {
    const cheap = this.cheapModel ?? this.chatModel;
    const smart = this.smartModel ?? this.chatModel;
    return this.shouldUseCheapForSqlGen(tableCount, priorAttempts, changeType)
      ? cheap
      : smart;
  }
}

/** Loop-carry state threaded between dountil iterations. */
export interface SqlLoopState {
  prompt?: string;
  tables?: string[];
  checklist?: string;
  feedback?: string;
  attempts?: number;
  changeType?: ChangeType;
  cached?: boolean;
  datasetId?: string;
  sql?: string;
  unanswerable?: boolean;
  replyToUser?: string;
  sampleSql?: string;
  samplePrompt?: string;
  skip?: boolean;
  genError?: string;
  passed?: boolean;
  description?: string;
}

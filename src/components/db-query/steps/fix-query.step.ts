import {inject, service} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {PermissionHelper} from '../services';
import type {SchemaStore} from '../services/schema.store';
import {SqlValidatorService} from '../services/sql-validator.service';
import type {IDbConnector} from '../types';
import {buildImproveSqlPrompt, emitToolStatus, runSqlAttempt} from './_helpers';
import {STEP_FIX_QUERY} from './constants';
import {loadErrorShortCircuit} from './improve.shared';

/**
 * Re-generate + validate an improved SQL query per dountil iteration (the
 * Mastra-named successor of the LangGraph FixQueryNode). DI-resolved `@step`
 * class.
 */
@step(STEP_FIX_QUERY)
export class FixQueryStep implements IWorkflowStep {
  constructor(
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject(DbQueryAIExtensionBindings.Connector, {optional: true})
    private readonly dbConnector?: IDbConnector,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly globalContext: string[] = [],
    @inject('services.PermissionHelper', {optional: true})
    private readonly permissionHelper?: PermissionHelper,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
    @inject(AiIntegrationBindings.SmartModel, {optional: true})
    private readonly smartModel?: LanguageModel,
    @service(SqlValidatorService, {optional: true})
    private readonly sqlValidator: SqlValidatorService = new SqlValidatorService(),
  ) {}

  /**
   * Gather the SQL-gen schema inputs from the injected SchemaStore (fail-open
   * when unbound). Extracted to keep `execute` under the complexity cap (S1541).
   */
  private resolveSchemaInputs(tables: string[]) {
    const store = this.schemaStore;
    return {
      allTables: store?.allTableNames() ?? [],
      columns: store?.tablesWithColumns(tables) ?? {},
      schema: store?.schemaForPrompt(this.dbConnector, tables),
    };
  }

  async execute({inputData, requestContext, tracingContext}: WorkflowStepCtx) {
    emitToolStatus(
      requestContext,
      STEP_FIX_QUERY,
      'Fixing SQL query based on validation errors',
    );

    const data = inputData as {
      datasetId?: string;
      prompt?: string;
      originalSql?: string;
      tables?: string[];
      checklist?: string;
      feedback?: string;
      attempts?: number;
      loadError?: boolean;
    };

    if (data.loadError) return loadErrorShortCircuit(data);

    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const {dbConnector} = this;
    const {allTables, columns, schema} = this.resolveSchemaInputs(tables);

    const attempt = await runSqlAttempt({
      chatLlm: this.smartModel ?? this.chatModel,
      cheapLlm: this.cheapModel ?? this.chatModel,
      allTables,
      tracing: tracingContext,
      dbConnector,
      prompt,
      tables,
      columns,
      schema,
      checks: this.globalContext,
      checklist: data.checklist,
      feedback: data.feedback,
      buildPrompt: buildImproveSqlPrompt,
      initialSql: data.originalSql,
      rc: requestContext,
      permissionHelper: this.permissionHelper,
      sqlValidator: this.sqlValidator,
      onReselectTables: () =>
        emitToolStatus(
          requestContext,
          STEP_FIX_QUERY,
          'Reselecting tables to resolve a missing table or column',
        ),
    });

    return {
      datasetId: data.datasetId ?? '',
      sql: attempt.sql,
      passed: attempt.passed,
      attempts: (data.attempts ?? 0) + 1,
      feedback: attempt.feedback,
      description: undefined,
      prompt,
      tables: attempt.tables ?? tables,
      checklist: data.checklist ?? '',
    };
  }
}

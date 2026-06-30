import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {InternalBindings} from '../../../runtime/internal-bindings';
import {DbQueryAIExtensionBindings} from '../keys';
import type {PermissionHelper} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {IDbConnector} from '../types';
import {
  buildImproveSqlPrompt,
  emitToolStatus,
  getAllSchemaTables,
  getSchemaForPrompt,
  getTablesWithColumns,
  runSqlAttempt,
} from './_helpers';
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
    @inject(InternalBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(InternalBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
    @inject(InternalBindings.SmartModel, {optional: true})
    private readonly smartModel?: LanguageModel,
  ) {}

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
    const {schemaStore, dbConnector} = this;
    const columns = getTablesWithColumns(schemaStore, tables);

    const attempt = await runSqlAttempt({
      chatLlm: this.smartModel ?? this.chatModel,
      cheapLlm: this.cheapModel ?? this.chatModel,
      allTables: getAllSchemaTables(schemaStore),
      tracing: tracingContext,
      dbConnector,
      prompt,
      tables,
      columns,
      schema: getSchemaForPrompt(schemaStore, dbConnector, tables),
      checks: this.globalContext,
      checklist: data.checklist,
      feedback: data.feedback,
      buildPrompt: buildImproveSqlPrompt,
      initialSql: data.originalSql,
      rc: requestContext,
      permissionHelper: this.permissionHelper,
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

import {inject} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {InternalBindings} from '../../../runtime/internal-bindings';
import {DbQueryAIExtensionBindings} from '../keys';
import type {PermissionHelper} from '../services';
import type {SchemaStore} from '../services/schema.store';
import type {DbQueryConfig, IDbConnector} from '../types';
import {
  buildGenerateSqlPrompt,
  emitToolStatus,
  getAllSchemaTables,
  getSchemaForPrompt,
  getTablesWithColumns,
  runSqlAttempt,
  shouldUseCheapForSqlGen,
} from './_helpers';
import {MAX_VALIDATION_ATTEMPTS, STEP_SQL_AND_VALIDATE} from './constants';

function cachedSqlPassthrough(data: {
  attempts?: number;
  cached?: boolean;
  datasetId?: string;
  sql?: string;
}) {
  if (!(data.cached && data.datasetId)) return null;
  return {
    sql: data.sql ?? '',
    passed: true,
    attempts: (data.attempts ?? 0) + 1,
    feedback: undefined,
    description: '',
    prompt: '',
    tables: [] as string[],
    checklist: '',
    cached: true,
    datasetId: data.datasetId,
  };
}

// The get-columns gate judged the question unanswerable. Exit the dountil
// immediately (attempts forced to the cap, passed=false) so NO smart-tier
// SQL generation runs and the final branch routes to failedStep.
function unanswerableShortCircuit(data: {
  unanswerable?: boolean;
  replyToUser?: string;
  prompt?: string;
}) {
  if (!data.unanswerable) return null;
  return {
    sql: '',
    passed: false,
    attempts: MAX_VALIDATION_ATTEMPTS,
    feedback: undefined,
    description: '',
    prompt: data.prompt ?? '',
    tables: [] as string[],
    checklist: '',
    unanswerable: true,
    replyToUser: data.replyToUser ?? '',
  };
}

// Tier selection (restores v2 cost optimisation): cheap tier for retries and
// single-table queries, smart for multi-table first attempts.
function pickGenLlm(args: {
  config?: DbQueryConfig;
  tableCount: number;
  priorAttempts: number;
  cheap?: LanguageModel;
  smart?: LanguageModel;
  chat?: LanguageModel;
}): LanguageModel | undefined {
  return shouldUseCheapForSqlGen(
    args.config,
    args.tableCount,
    args.priorAttempts,
  )
    ? (args.cheap ?? args.chat)
    : (args.smart ?? args.chat);
}

function buildStepResult(
  attempt: {
    sql: string;
    passed: boolean;
    feedback?: string;
    description?: string;
    tables?: string[];
  },
  priorAttempts: number,
  prompt: string,
  tables: string[],
  data: {checklist?: string; sampleSql?: string; samplePrompt?: string},
) {
  return {
    sql: attempt.sql,
    passed: attempt.passed,
    attempts: priorAttempts + 1,
    feedback: attempt.feedback,
    description: attempt.description ?? '',
    prompt,
    tables: attempt.tables ?? tables,
    checklist: data.checklist ?? '',
    sampleSql: data.sampleSql,
    samplePrompt: data.samplePrompt,
  };
}

function sqlStatusEmitters(
  requestContext: Parameters<typeof emitToolStatus>[0],
) {
  return {
    onReselectTables: () =>
      emitToolStatus(
        requestContext,
        STEP_SQL_AND_VALIDATE,
        'Reselecting tables to resolve a missing table or column',
      ),
    onStatus: (stage: 'syntactic' | 'semantic') =>
      emitToolStatus(
        requestContext,
        STEP_SQL_AND_VALIDATE,
        stage === 'syntactic'
          ? 'Validating generated SQL query'
          : "Verifying if the query fully satisfies the user's requirement",
      ),
  };
}

/**
 * Generate + validate one SQL attempt per dountil iteration (the Mastra-named
 * successor of the LangGraph SqlGeneration + validator nodes). All
 * collaborators are constructor-injected — the connector, schema store, config,
 * global context, permission helper, and the per-request resolved model tiers.
 * Only the SSE writer + Mastra engine data (inputData/tracing) come via the
 * step ctx (the LangGraph `config`/`state` equivalent).
 */
@step(STEP_SQL_AND_VALIDATE)
export class SqlAndValidateStep implements IWorkflowStep {
  constructor(
    @inject(DbQueryAIExtensionBindings.Connector, {optional: true})
    private readonly dbConnector?: IDbConnector,
    @inject('services.SchemaStore', {optional: true})
    private readonly schemaStore?: SchemaStore,
    @inject(DbQueryAIExtensionBindings.Config, {optional: true})
    private readonly config?: DbQueryConfig,
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
    const data = inputData as {
      prompt?: string;
      tables?: string[];
      checklist?: string;
      feedback?: string;
      attempts?: number;
      cached?: boolean;
      datasetId?: string;
      sql?: string;
      unanswerable?: boolean;
      replyToUser?: string;
      sampleSql?: string;
      samplePrompt?: string;
    };

    const cached = cachedSqlPassthrough(data);
    if (cached) return cached;

    const blocked = unanswerableShortCircuit(data);
    if (blocked) return blocked;

    emitToolStatus(
      requestContext,
      STEP_SQL_AND_VALIDATE,
      'Generating SQL query from the prompt',
    );

    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const priorAttempts = data.attempts ?? 0;
    const cheap = this.cheapModel ?? this.chatModel;

    // Streaming description (v2 generate-description) — default ON; opt out per
    // consumer with `nodes.sqlGenerationNode.generateDescription = false`.
    const generateDescription =
      this.config?.nodes?.sqlGenerationNode?.generateDescription !== false;

    const attempt = await runSqlAttempt({
      chatLlm: pickGenLlm({
        config: this.config,
        tableCount: tables.length,
        priorAttempts,
        cheap,
        smart: this.smartModel ?? this.chatModel,
        chat: this.chatModel,
      }),
      cheapLlm: cheap,
      allTables: getAllSchemaTables(this.schemaStore),
      tracing: tracingContext,
      dbConnector: this.dbConnector,
      prompt,
      tables,
      columns: getTablesWithColumns(this.schemaStore, tables),
      schema: getSchemaForPrompt(this.schemaStore, this.dbConnector, tables),
      checks: this.globalContext,
      checklist: data.checklist,
      feedback: data.feedback,
      sampleSql: data.sampleSql,
      samplePrompt: data.samplePrompt,
      buildPrompt: buildGenerateSqlPrompt,
      buildDescription: (_sql, p) => `Generated SQL for: ${p}`,
      lastAttempt: priorAttempts + 1 >= MAX_VALIDATION_ATTEMPTS,
      descriptionLlm: generateDescription ? cheap : undefined,
      rc: requestContext,
      permissionHelper: this.permissionHelper,
      ...sqlStatusEmitters(requestContext),
    });

    return buildStepResult(attempt, priorAttempts, prompt, tables, data);
  }
}

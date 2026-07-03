import {inject, service} from '@loopback/core';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {PermissionHelper} from '../services';
import type {SchemaStore} from '../services/schema.store';
import {SqlValidatorService} from '../services/sql-validator.service';
import type {DbQueryConfig, IDbConnector} from '../types';
import {
  buildGenerateSqlPrompt,
  emitToolStatus,
  runSqlAttempt,
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

/**
 * Pick the SQL-generation tier (restores v2 SqlGenerationNode cost
 * optimisation, which v3 dropped — every gen ran on the smart tier). Cheap
 * tier is good enough and ~halves cost/latency when:
 *   - this is a validation-fix RETRY (the query is close, only small edits),
 *   - or it's a single-table query (no joins to reason about) — unless the
 *     consumer forces smart via
 *     `nodes.sqlGenerationNode.useSmartLLMForSingleTableQueries`.
 * Multi-table first attempts use the smart tier.
 */
export function shouldUseCheapForSqlGen(
  config: DbQueryConfig | undefined,
  tableCount: number,
  priorAttempts: number,
): boolean {
  // any prior attempt means this is a validation-fix retry
  if (priorAttempts > 0) return true;
  const forceSmartSingle =
    config?.nodes?.sqlGenerationNode?.useSmartLLMForSingleTableQueries === true;
  return tableCount <= 1 && !forceSmartSingle;
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
   * Resolve the per-attempt model tiers + description toggle. Extracted from
   * `execute` to keep it under the cyclomatic complexity cap (S1541).
   */
  private resolveAttemptModels(tableCount: number, priorAttempts: number) {
    const cheap = this.cheapModel ?? this.chatModel;
    const chatLlm = pickGenLlm({
      config: this.config,
      tableCount,
      priorAttempts,
      cheap,
      smart: this.smartModel ?? this.chatModel,
      chat: this.chatModel,
    });
    const wantsDescription =
      this.config?.nodes?.sqlGenerationNode?.generateDescription !== false;
    return {
      cheap,
      chatLlm,
      descriptionLlm: wantsDescription ? cheap : undefined,
    };
  }

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
    const {cheap, chatLlm, descriptionLlm} = this.resolveAttemptModels(
      tables.length,
      priorAttempts,
    );
    const {allTables, columns, schema} = this.resolveSchemaInputs(tables);

    const attempt = await runSqlAttempt({
      chatLlm,
      cheapLlm: cheap,
      allTables,
      tracing: tracingContext,
      dbConnector: this.dbConnector,
      prompt,
      tables,
      columns,
      schema,
      checks: this.globalContext,
      checklist: data.checklist,
      feedback: data.feedback,
      sampleSql: data.sampleSql,
      samplePrompt: data.samplePrompt,
      buildPrompt: buildGenerateSqlPrompt,
      buildDescription: (_sql, p) => `Generated SQL for: ${p}`,
      lastAttempt: priorAttempts + 1 >= MAX_VALIDATION_ATTEMPTS,
      descriptionLlm,
      rc: requestContext,
      permissionHelper: this.permissionHelper,
      sqlValidator: this.sqlValidator,
      ...sqlStatusEmitters(requestContext),
    });

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
}

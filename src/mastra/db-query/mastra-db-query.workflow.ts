import {BindingScope, inject, injectable, service} from '@loopback/core';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {
  DataSetHelper,
  DbSchemaHelperService,
  PermissionHelper,
} from '../../components/db-query/services';
import {SchemaStore} from '../../components/db-query/services/schema.store';
import {TableSearchService} from '../../components/db-query/services/search/table-search.service';
import {DbQueryState} from '../../components/db-query/state';
import {
  DbQueryConfig,
  Errors,
  GenerationError,
  IDataSetStore,
  IDbConnector,
} from '../../components/db-query/types';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import {MAX_ATTEMPTS} from '../../components/db-query/constant';
import {AiIntegrationBindings} from '../../keys';
import {LLMProvider} from '../../types';
import {TokenCounter} from '../../services/token-counter.service';
import {DatasetSearchService} from './services/dataset-search.service';
import {MastraTemplateHelperService} from './services/mastra-template-helper.service';
import {TemplateSearchService} from './services/template-search.service';
import {
  DbQueryWorkflowInput,
  MastraDbQueryContext,
} from './types/db-query.types';
import {
  checkPostCacheAndTablesConditions,
  checkPostValidationConditions,
  mergeValidationResults,
  failedStep,
  isImprovementStep,
  classifyChangeStep,
  checkCacheStep,
  checkPermissionsStep,
  checkTemplatesStep,
  getTablesStep,
  getColumnsStep,
  generateChecklistStep,
  verifyChecklistStep,
  sqlGenerationStep,
  syntacticValidatorStep,
  semanticValidatorStep,
  generateDescriptionStep,
  fixQueryStep,
  saveDatasetStep,
} from './workflow';

const debug = require('debug')('mastra:db-query:workflow');

/**
 * Mastra-path imperative workflow for the DbQuery feature.
 *
 * Injects all services directly and delegates to step functions in
 * `workflow/steps/`. This eliminates class-based node wrappers and keeps
 * execution units as plain async functions.
 *
 * Preserves 100% of the original orchestration behaviour:
 *  - Same parallel fan-out / fan-in with `Promise.all()`
 *  - Same validation-retry loop with `MAX_ATTEMPTS` guard
 *  - Same conditional routing (template hit, cache hit, table error, query error)
 *  - Same state-merging semantics (last-write-wins per field)
 *
 * @injectable `BindingScope.REQUEST` — one instance per HTTP request.
 */
@injectable({scope: BindingScope.REQUEST})
export class MastraDbQueryWorkflow {
  constructor(
    // ── LLM providers ──────────────────────────────────────────────────────
    @inject(AiIntegrationBindings.AiSdkCheapLLM)
    private readonly cheapLlm: LLMProvider,
    @inject(AiIntegrationBindings.AiSdkSmartLLM)
    private readonly smartLlm: LLMProvider,
    @inject(AiIntegrationBindings.AiSdkSmartNonThinkingLLM, {optional: true})
    private readonly smartNonThinkingLlm: LLMProvider | undefined,

    // ── Data stores & config ────────────────────────────────────────────────
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly datasetStore: IDataSetStore,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @inject(DbQueryAIExtensionBindings.Connector)
    private readonly connector: IDbConnector,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: IAuthUserWithPermissions,
    @inject(DbQueryAIExtensionBindings.GlobalContext, {optional: true})
    private readonly checks: string[] | undefined,

    // ── Services ────────────────────────────────────────────────────────────
    @service(DatasetSearchService)
    private readonly datasetSearch: DatasetSearchService,
    @service(DataSetHelper)
    private readonly dataSetHelper: DataSetHelper,
    @service(PermissionHelper)
    private readonly permissionHelper: PermissionHelper,
    @service(TemplateSearchService)
    private readonly templateSearch: TemplateSearchService,
    @service(MastraTemplateHelperService)
    private readonly templateHelper: MastraTemplateHelperService,
    @service(SchemaStore)
    private readonly schemaStore: SchemaStore,
    @service(TableSearchService)
    private readonly tableSearch: TableSearchService,
    @service(DbSchemaHelperService)
    private readonly schemaHelper: DbSchemaHelperService,
    @service(TokenCounter)
    private readonly tokenCounter: TokenCounter,
  ) {}

  /**
   * Execute the full DbQuery workflow.
   *
   * @param input  User prompt and optional datasetId / directCall flag.
   * @param ctx    Execution context: SSE writer and/or AbortSignal.
   */
  async run(
    input: DbQueryWorkflowInput,
    ctx?: MastraDbQueryContext,
  ): Promise<DbQueryState> {
    const context: MastraDbQueryContext = {
      ...ctx,
      onUsage: (i, o, m) => {
        this.tokenCounter.accumulate(i, o, m);
        if (ctx?.onUsage) ctx.onUsage(i, o, m);
      },
    };

    debug(
      'Workflow START prompt=%s datasetId=%s',
      input.prompt,
      input.datasetId,
    );

    // ── Initial state ───────────────────────────────────────────────────────
    let state: DbQueryState = {
      prompt: input.prompt,
      datasetId: input.datasetId,
      directCall: input.directCall ?? false,
      schema: {tables: {}, relations: []},
    } as unknown as DbQueryState;

    // ── Step 1: IsImprovement ───────────────────────────────────────────────
    debug('Executing step: IsImprovement');
    state = this._merge(
      state,
      await isImprovementStep(state, context, {store: this.datasetStore}),
    );
    debug('Completed step: IsImprovement');

    // ── Step 2: Parallel fan-out ────────────────────────────────────────────
    debug(
      'Executing step: CheckCache|GetTables|CheckTemplates|ClassifyChange (parallel)',
    );
    const [cachePartial, tablesPartial, templatesPartial, classifyPartial] =
      await Promise.all([
        checkCacheStep(state, context, {
          datasetSearch: this.datasetSearch,
          llm: this.cheapLlm,
          dataSetHelper: this.dataSetHelper,
        }),
        getTablesStep(state, context, {
          llmCheap: this.cheapLlm,
          llmSmart: this.smartLlm,
          config: this.config,
          schemaHelper: this.schemaHelper,
          schemaStore: this.schemaStore,
          tableSearchService: this.tableSearch,
          checks: this.checks,
          permissionHelper: this.permissionHelper,
        }),
        checkTemplatesStep(state, context, {
          templateSearch: this.templateSearch,
          llm: this.cheapLlm,
          permissionHelper: this.permissionHelper,
          templateHelper: this.templateHelper,
          schemaStore: this.schemaStore,
        }),
        classifyChangeStep(state, context, {llm: this.cheapLlm}),
      ]);
    state = this._merge(
      state,
      cachePartial,
      tablesPartial,
      templatesPartial,
      classifyPartial,
    );
    debug(
      'Completed step: CheckCache|GetTables|CheckTemplates|ClassifyChange (parallel)',
    );

    // ── Step 3: PostCacheAndTables routing ──────────────────────────────────
    const cacheCondition = checkPostCacheAndTablesConditions(state);
    debug('Branch decision: %o', cacheCondition);

    if (cacheCondition === 'fromTemplate') {
      debug('Executing step: SaveDataset (fromTemplate)');
      state = this._merge(state, await this._runSaveDataset(state, context));
      debug('Workflow END success=true (fromTemplate)');
      return state;
    }

    if (cacheCondition === 'fromCache') {
      debug('Workflow END success=true (fromCache)');
      return state;
    }

    if (cacheCondition === 'failed') {
      debug('Executing step: Failed (post-cache)');
      state = this._merge(state, await failedStep(state, context));
      debug('Workflow END success=false (failed post-cache)');
      return state;
    }

    // ── Step 4: GetColumns ──────────────────────────────────────────────────
    debug('Executing step: GetColumns');
    state = this._merge(
      state,
      await getColumnsStep(state, context, {
        llm: this.cheapLlm,
        schemaHelper: this.schemaHelper,
        config: this.config,
        checks: this.checks,
      }),
    );
    debug('Completed step: GetColumns');
    if (state.status === GenerationError.Failed) {
      debug('Executing step: Failed (GetColumns)');
      state = this._merge(state, await failedStep(state, context));
      debug('Workflow END success=false (GetColumns failed)');
      return state;
    }

    // ── Step 5: CheckPermissions ────────────────────────────────────────────
    debug('Executing step: CheckPermissions');
    state = this._merge(
      state,
      await checkPermissionsStep(state, context, {
        llm: this.cheapLlm,
        permissions: this.permissionHelper,
      }),
    );
    debug('Completed step: CheckPermissions');
    if (state.status === Errors.PermissionError) {
      debug('Workflow END success=false (PermissionError)');
      return state;
    }

    // ── Step 6: GenerateChecklist ───────────────────────────────────────────
    debug('Executing step: GenerateChecklist');
    state = this._merge(
      state,
      await generateChecklistStep(state, context, {
        llm: this.cheapLlm,
        config: this.config,
        schemaHelper: this.schemaHelper,
        checks: this.checks,
      }),
    );
    debug('Completed step: GenerateChecklist');

    // ── Steps 7–10: SQL generation + validation retry loop ──────────────────
    type LoopEntry = 'generate' | 'validate';
    let loopEntry: LoopEntry = 'generate';

    const maxIterations = MAX_ATTEMPTS * 2 + 2;
    let iterations = 0;

    while (iterations++ < maxIterations) {
      debug('Retry attempt: %d loopEntry=%s', iterations, loopEntry);

      if (loopEntry === 'generate') {
        debug('Executing step: SqlGeneration|VerifyChecklist (parallel)');
        const [sqlPartial, checklistPartial] = await Promise.all([
          sqlGenerationStep(state, context, {
            sqlLLM: this.smartLlm,
            cheapLLM: this.cheapLlm,
            config: this.config,
            schemaHelper: this.schemaHelper,
            checks: this.checks,
          }),
          verifyChecklistStep(state, context, {
            smartLlm: this.smartLlm,
            smartNonThinkingLlm: this.smartNonThinkingLlm,
            config: this.config,
            schemaHelper: this.schemaHelper,
            checks: this.checks,
          }),
        ]);
        state = this._merge(state, sqlPartial, checklistPartial);
        debug('Completed step: SqlGeneration|VerifyChecklist (parallel)');

        if (state.status === GenerationError.Failed) {
          debug('Executing step: Failed (SqlGeneration)');
          state = this._merge(state, await failedStep(state, context));
          debug('Workflow END success=false (SqlGeneration failed)');
          return state;
        }
      }

      debug(
        'Executing step: SyntacticValidator|SemanticValidator|GenerateDescription (parallel)',
      );
      const [syntacticPartial, semanticPartial, descPartial] =
        await Promise.all([
          syntacticValidatorStep(state, context, {
            llm: this.cheapLlm,
            connector: this.connector,
          }),
          semanticValidatorStep(state, context, {
            smartLlm: this.smartLlm,
            cheapLlm: this.cheapLlm,
            config: this.config,
            tableSearchService: this.tableSearch,
            schemaHelper: this.schemaHelper,
            permissionHelper: this.permissionHelper,
          }),
          generateDescriptionStep(state, context, {
            llm: this.cheapLlm,
            config: this.config,
            schemaHelper: this.schemaHelper,
            checks: this.checks,
          }),
        ]);
      state = this._merge(
        state,
        syntacticPartial,
        semanticPartial,
        descPartial,
      );
      debug(
        'Completed step: SyntacticValidator|SemanticValidator|GenerateDescription (parallel)',
      );

      state = this._merge(state, mergeValidationResults(state));

      if ((state.feedbacks?.length ?? 0) >= MAX_ATTEMPTS) {
        debug(
          'Workflow error: max attempts reached feedbacks=%d',
          state.feedbacks?.length,
        );
        state = this._merge(state, await failedStep(state, context));
        debug('Workflow END success=false (max attempts)');
        return state;
      }

      const validationCondition = checkPostValidationConditions(state);
      debug('Branch decision: %o', validationCondition);

      if (validationCondition === 'accepted') {
        debug('Executing step: SaveDataset (accepted)');
        state = this._merge(state, await this._runSaveDataset(state, context));
        debug('Workflow END success=true (accepted)');
        return state;
      }

      if (validationCondition === 'reselectTables') {
        debug('Executing step: GetTables (reselectTables)');
        state = this._merge(
          state,
          await getTablesStep(state, context, {
            llmCheap: this.cheapLlm,
            llmSmart: this.smartLlm,
            config: this.config,
            schemaHelper: this.schemaHelper,
            schemaStore: this.schemaStore,
            tableSearchService: this.tableSearch,
            checks: this.checks,
            permissionHelper: this.permissionHelper,
          }),
        );
        debug('Completed step: GetTables');
        if (state.status === GenerationError.Failed) {
          debug('Executing step: Failed (GetTables reselect)');
          state = this._merge(state, await failedStep(state, context));
          debug('Workflow END success=false (GetTables reselect failed)');
          return state;
        }
        debug('Executing step: GetColumns (reselectTables)');
        state = this._merge(
          state,
          await getColumnsStep(state, context, {
            llm: this.cheapLlm,
            schemaHelper: this.schemaHelper,
            config: this.config,
            checks: this.checks,
          }),
        );
        debug('Completed step: GetColumns');
        if (state.status === GenerationError.Failed) {
          debug('Executing step: Failed (GetColumns reselect)');
          state = this._merge(state, await failedStep(state, context));
          debug('Workflow END success=false (GetColumns reselect failed)');
          return state;
        }
        debug('Executing step: GenerateChecklist (reselectTables)');
        state = this._merge(
          state,
          await generateChecklistStep(state, context, {
            llm: this.cheapLlm,
            config: this.config,
            schemaHelper: this.schemaHelper,
            checks: this.checks,
          }),
        );
        debug('Completed step: GenerateChecklist');
        loopEntry = 'generate';
        continue;
      }

      if (validationCondition === 'fixSql') {
        debug('Executing step: FixQuery');
        state = this._merge(
          state,
          await fixQueryStep(state, context, {
            llm: this.cheapLlm,
            config: this.config,
            schemaHelper: this.schemaHelper,
          }),
        );
        debug('Completed step: FixQuery');
        if (state.status === GenerationError.Failed) {
          debug('Executing step: Failed (FixQuery)');
          state = this._merge(state, await failedStep(state, context));
          debug('Workflow END success=false (FixQuery failed)');
          return state;
        }
        loopEntry = 'validate';
        continue;
      }

      debug(
        'Workflow error: unknown validationCondition=%o',
        validationCondition,
      );
      state = this._merge(state, await failedStep(state, context));
      debug('Workflow END success=false (unknown condition)');
      return state;
    }

    debug('Workflow error: exceeded safety cap iterations=%d', iterations);
    state = this._merge(state, await failedStep(state, context));
    debug('Workflow END success=false (safety cap)');
    return state;
  }

  private _runSaveDataset(
    state: DbQueryState,
    context: MastraDbQueryContext,
  ): Promise<Partial<DbQueryState>> {
    return saveDatasetStep(state, context, {
      llm: this.cheapLlm,
      store: this.datasetStore,
      config: this.config,
      user: this.user,
      dbSchemaHelper: this.schemaHelper,
      checks: this.checks,
    });
  }

  private _merge(
    base: DbQueryState,
    ...partials: Partial<DbQueryState>[]
  ): DbQueryState {
    return Object.assign({}, base, ...partials) as DbQueryState;
  }
}

import {BindingScope, inject, injectable, service} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {z} from 'zod';
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
import {adaptMastraEvent} from '../workflow-event-adapter';
import {
  checkPostCacheAndTablesConditions,
  checkPostValidationConditions,
  mergeValidationResults,
  runFailed,
  runIsImprovement,
  runCheckCache,
  runCheckPermissions,
  runCheckTemplates,
  runClassifyChange,
  runGetTables,
  runGetColumns,
  runGenerateChecklist,
  runVerifyChecklist,
  runSqlGeneration,
  runSyntacticValidator,
  runSemanticValidator,
  runGenerateDescription,
  runFixQuery,
  runSaveDataset,
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
    @inject(AiIntegrationBindings.LangfuseMastraClient, {optional: true})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly langfuse: any | undefined,
  ) {}

  /**
   * Execute the full DbQuery workflow using Mastra-native DSL.
   *
   * Uses `.then()` for sequential steps, `.parallel()` for concurrent
   * fan-out, and `.branch()` for post-cache routing.  The validation retry
   * loop lives inside `validationLoopBound` (Option A from the spec).
   *
   * Per-request bound steps close over `context` and `this.*` services so
   * that LoopBack's request-scoped DI works without embedding live service
   * instances in Mastra's serialisable workflow state.
   *
   * @param input  User prompt and optional datasetId / directCall flag.
   * @param ctx    Execution context: SSE writer and/or AbortSignal.
   */
  async run(
    input: DbQueryWorkflowInput,
    ctx?: MastraDbQueryContext,
  ): Promise<DbQueryState> {
    const context = this._buildContext(ctx);
    const initialState = {
      prompt: input.prompt,
      datasetId: input.datasetId,
      directCall: input.directCall ?? false,
      schema: {tables: {}, relations: []},
    } as unknown as DbQueryState;

    // ── Per-request bound steps (close over context + this.* deps) ──────────

    const isImprovementBound = createStep({
      id: 'is-improvement-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({inputData}: {inputData: DbQueryState}) => {
        debug('Executing step: IsImprovement');
        const partial = await runIsImprovement(inputData, context, {
          store: this.datasetStore,
        });
        debug('Completed step: IsImprovement');
        return {...inputData, ...partial};
      },
    });

    // Parallel preflight steps — return ONLY their delta (Partial<DbQueryState>)
    // The merge step recombines them using getStepResult(isImprovementBound).

    const checkCacheBound = createStep({
      id: 'check-cache-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({inputData}: {inputData: DbQueryState}) => {
        debug('Executing step: CheckCache');
        return runCheckCache(inputData, context, {
          datasetSearch: this.datasetSearch,
          llm: this.cheapLlm,
          dataSetHelper: this.dataSetHelper,
        });
      },
    });

    const getTablesBound = createStep({
      id: 'get-tables-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({inputData}: {inputData: DbQueryState}) => {
        debug('Executing step: GetTables');
        return runGetTables(inputData, context, {
          llmCheap: this.cheapLlm,
          llmSmart: this.smartLlm,
          config: this.config,
          schemaHelper: this.schemaHelper,
          schemaStore: this.schemaStore,
          tableSearchService: this.tableSearch,
          checks: this.checks,
          permissionHelper: this.permissionHelper,
        });
      },
    });

    const checkTemplatesBound = createStep({
      id: 'check-templates-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({inputData}: {inputData: DbQueryState}) => {
        debug('Executing step: CheckTemplates');
        return runCheckTemplates(inputData, context, {
          templateSearch: this.templateSearch,
          llm: this.cheapLlm,
          permissionHelper: this.permissionHelper,
          templateHelper: this.templateHelper,
          schemaStore: this.schemaStore,
        });
      },
    });

    const classifyChangeBound = createStep({
      id: 'classify-change-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({inputData}: {inputData: DbQueryState}) => {
        debug('Executing step: ClassifyChange');
        return runClassifyChange(inputData, context, {llm: this.cheapLlm});
      },
    });

    /**
     * Merge parallel preflight outputs into a single DbQueryState.
     * Uses getStepResult(isImprovementBound) as the base state so fields set
     * by isImprovement (e.g. sampleSql, sampleSqlPrompt) are not lost.
     */
    const mergePreflightBound = createStep({
      id: 'merge-preflight-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async ({inputData, getStepResult}: any) => {
        debug(
          'Executing step: MergePreflight (CheckCache|GetTables|CheckTemplates|ClassifyChange)',
        );
        const baseState =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((getStepResult as any)(isImprovementBound) as DbQueryState) ??
          ({} as DbQueryState);
        const partials = Object.values(inputData as Record<string, object>);
        const merged = Object.assign({}, baseState, ...partials);
        debug('Completed step: MergePreflight');
        return merged;
      },
    });

    // ── Post-cache routing step ──────────────────────────────────────────────
    // NOTE: Replaces .branch([]) which loses state when no condition matches.
    // Mastra outputs {} for the next step when no branch condition is true,
    // wiping schema and all accumulated state. A single inline router avoids
    // this entirely — state always flows through unchanged on the happy path.

    const postCacheRouterBound = createStep({
      id: 'post-cache-router-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: DbQueryState & {workflowDone?: boolean};
      }) => {
        const condition = checkPostCacheAndTablesConditions(
          inputData as DbQueryState,
        );
        debug('Post-cache routing condition: %s', condition);

        if (condition === 'fromTemplate') {
          debug('Executing step: SaveDataset (fromTemplate)');
          const partial = await runSaveDataset(inputData, context, {
            llm: this.cheapLlm,
            store: this.datasetStore,
            config: this.config,
            user: this.user,
            dbSchemaHelper: this.schemaHelper,
            checks: this.checks,
          });
          debug('Workflow END success=true (fromTemplate)');
          return {...inputData, ...partial, workflowDone: true};
        }

        if (condition === 'fromCache') {
          debug('Workflow END success=true (fromCache)');
          return {...inputData, workflowDone: true};
        }

        if (condition === 'failed') {
          debug('Executing step: Failed (post-cache)');
          const partial = await runFailed(inputData, context);
          debug('Workflow END success=false (failed post-cache)');
          return {...inputData, ...partial, workflowDone: true};
        }

        // Happy path: continue to SQL generation with state intact.
        debug('Post-cache router: continuing to SQL generation');
        return inputData;
      },
    });

    // ── Pre-generation sequential steps (guarded by workflowDone) ───────────

    const getColumnsBound = createStep({
      id: 'get-columns-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: DbQueryState & {workflowDone?: boolean};
      }) => {
        if (inputData.workflowDone) return inputData;
        debug('Executing step: GetColumns');
        const partial = await runGetColumns(inputData, context, {
          llm: this.cheapLlm,
          schemaHelper: this.schemaHelper,
          config: this.config,
          checks: this.checks,
        });
        const next = {...inputData, ...partial};
        debug('Completed step: GetColumns');
        if (next.status === GenerationError.Failed) {
          debug('Executing step: Failed (GetColumns)');
          const failedPartial = await runFailed(next, context);
          debug('Workflow END success=false (GetColumns failed)');
          return {...next, ...failedPartial, workflowDone: true};
        }
        return next;
      },
    });

    const checkPermissionsBound = createStep({
      id: 'check-permissions-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: DbQueryState & {workflowDone?: boolean};
      }) => {
        if (inputData.workflowDone) return inputData;
        debug('Executing step: CheckPermissions');
        const partial = await runCheckPermissions(inputData, context, {
          llm: this.cheapLlm,
          permissions: this.permissionHelper,
        });
        const next = {...inputData, ...partial};
        debug('Completed step: CheckPermissions');
        if (next.status === Errors.PermissionError) {
          debug('Workflow END success=false (PermissionError)');
          return {...next, workflowDone: true};
        }
        return next;
      },
    });

    const generateChecklistBound = createStep({
      id: 'generate-checklist-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: DbQueryState & {workflowDone?: boolean};
      }) => {
        if (inputData.workflowDone) return inputData;
        debug('Executing step: GenerateChecklist');
        const partial = await runGenerateChecklist(inputData, context, {
          llm: this.cheapLlm,
          config: this.config,
          schemaHelper: this.schemaHelper,
          checks: this.checks,
        });
        debug('Completed step: GenerateChecklist');
        return {...inputData, ...partial};
      },
    });

    /**
     * Validation loop — SQL generation + validation + retry.
     *
     * Option A (user spec): retry while-loop lives inside this single step.
     * The internal Promise.all calls are acceptable within a step's execute
     * function.  MAX_ATTEMPTS is preserved; no infinite loop is possible.
     */
    const validationLoopBound = createStep({
      id: 'validation-loop-bound',
      inputSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({
        inputData,
      }: {
        inputData: DbQueryState & {workflowDone?: boolean};
      }) => {
        if (inputData.workflowDone) return inputData;

        let state = inputData as DbQueryState;
        type LoopEntry = 'generate' | 'validate';
        let loopEntry: LoopEntry = 'generate';
        const maxIterations = MAX_ATTEMPTS * 2 + 2;
        let iterations = 0;

        while (iterations++ < maxIterations) {
          debug('Retry attempt: %d loopEntry=%s', iterations, loopEntry);

          if (loopEntry === 'generate') {
            debug('Executing step: SqlGeneration|VerifyChecklist (parallel)');
            const [sqlPartial, checklistPartial] = await Promise.all([
              runSqlGeneration(state, context, {
                sqlLLM: this.smartLlm,
                cheapLLM: this.cheapLlm,
                config: this.config,
                schemaHelper: this.schemaHelper,
                checks: this.checks,
              }),
              runVerifyChecklist(state, context, {
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
              const failedPartial = await runFailed(state, context);
              debug('Workflow END success=false (SqlGeneration failed)');
              return {
                ...this._merge(state, failedPartial),
                workflowDone: true,
              };
            }
          }

          debug(
            'Executing step: SyntacticValidator|SemanticValidator|GenerateDescription (parallel)',
          );
          const [syntacticPartial, semanticPartial, descPartial] =
            await Promise.all([
              runSyntacticValidator(state, context, {
                llm: this.cheapLlm,
                connector: this.connector,
              }),
              runSemanticValidator(state, context, {
                smartLlm: this.smartLlm,
                cheapLlm: this.cheapLlm,
                config: this.config,
                tableSearchService: this.tableSearch,
                schemaHelper: this.schemaHelper,
                permissionHelper: this.permissionHelper,
              }),
              runGenerateDescription(state, context, {
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
            const failedPartial = await runFailed(state, context);
            debug('Workflow END success=false (max attempts)');
            return {
              ...this._merge(state, failedPartial),
              workflowDone: true,
            };
          }

          const validationCondition = checkPostValidationConditions(state);
          debug('Branch decision: %o', validationCondition);

          if (validationCondition === 'accepted') {
            debug('Executing step: SaveDataset (accepted)');
            const savePartial = await runSaveDataset(state, context, {
              llm: this.cheapLlm,
              store: this.datasetStore,
              config: this.config,
              user: this.user,
              dbSchemaHelper: this.schemaHelper,
              checks: this.checks,
            });
            debug('Workflow END success=true (accepted)');
            return {
              ...this._merge(state, savePartial),
              workflowDone: true,
            };
          }

          if (validationCondition === 'reselectTables') {
            debug('Executing step: GetTables (reselectTables)');
            const tablesPartial = await runGetTables(state, context, {
              llmCheap: this.cheapLlm,
              llmSmart: this.smartLlm,
              config: this.config,
              schemaHelper: this.schemaHelper,
              schemaStore: this.schemaStore,
              tableSearchService: this.tableSearch,
              checks: this.checks,
              permissionHelper: this.permissionHelper,
            });
            state = this._merge(state, tablesPartial);
            debug('Completed step: GetTables');

            if (state.status === GenerationError.Failed) {
              debug('Executing step: Failed (GetTables reselect)');
              const failedPartial = await runFailed(state, context);
              debug('Workflow END success=false (GetTables reselect failed)');
              return {
                ...this._merge(state, failedPartial),
                workflowDone: true,
              };
            }

            debug('Executing step: GetColumns (reselectTables)');
            const colsPartial = await runGetColumns(state, context, {
              llm: this.cheapLlm,
              schemaHelper: this.schemaHelper,
              config: this.config,
              checks: this.checks,
            });
            state = this._merge(state, colsPartial);
            debug('Completed step: GetColumns');

            if (state.status === GenerationError.Failed) {
              debug('Executing step: Failed (GetColumns reselect)');
              const failedPartial = await runFailed(state, context);
              debug('Workflow END success=false (GetColumns reselect failed)');
              return {
                ...this._merge(state, failedPartial),
                workflowDone: true,
              };
            }

            debug('Executing step: GenerateChecklist (reselectTables)');
            const checklistPartial = await runGenerateChecklist(
              state,
              context,
              {
                llm: this.cheapLlm,
                config: this.config,
                schemaHelper: this.schemaHelper,
                checks: this.checks,
              },
            );
            state = this._merge(state, checklistPartial);
            debug('Completed step: GenerateChecklist');
            loopEntry = 'generate';
            continue;
          }

          if (validationCondition === 'fixSql') {
            debug('Executing step: FixQuery');
            const fixPartial = await runFixQuery(state, context, {
              llm: this.cheapLlm,
              config: this.config,
              schemaHelper: this.schemaHelper,
            });
            state = this._merge(state, fixPartial);
            debug('Completed step: FixQuery');

            if (state.status === GenerationError.Failed) {
              debug('Executing step: Failed (FixQuery)');
              const failedPartial = await runFailed(state, context);
              debug('Workflow END success=false (FixQuery failed)');
              return {
                ...this._merge(state, failedPartial),
                workflowDone: true,
              };
            }

            loopEntry = 'validate';
            continue;
          }

          debug(
            'Workflow error: unknown validationCondition=%o',
            validationCondition,
          );
          const unknownFailedPartial = await runFailed(state, context);
          debug('Workflow END success=false (unknown condition)');
          return {
            ...this._merge(state, unknownFailedPartial),
            workflowDone: true,
          };
        }

        debug('Workflow error: exceeded safety cap iterations=%d', iterations);
        const capFailedPartial = await runFailed(state, context);
        debug('Workflow END success=false (safety cap)');
        return {
          ...this._merge(state, capFailedPartial),
          workflowDone: true,
        };
      },
    });

    // ── Build and run Mastra workflow DSL ────────────────────────────────────
    const workflow = createWorkflow({
      id: 'db-query',
      inputSchema: z.any(),
      outputSchema: z.any(),
    })
      .then(isImprovementBound)
      .parallel([
        checkCacheBound,
        getTablesBound,
        checkTemplatesBound,
        classifyChangeBound,
      ])
      .then(mergePreflightBound)
      .then(postCacheRouterBound)
      .then(getColumnsBound)
      .then(checkPermissionsBound)
      .then(generateChecklistBound)
      .then(validationLoopBound)
      .commit();

    const run = await workflow.createRun();
    const result = await run.start({inputData: initialState});
    if (result.status === 'success') {
      const finalState = result.result as DbQueryState & {
        workflowDone?: boolean;
      };
      // Keep runtime sentinel internal; never leak to callers.
      delete finalState.workflowDone;
      return finalState;
    }
    return initialState;
  }

  private _buildContext(ctx?: MastraDbQueryContext): MastraDbQueryContext {
    const emit = (chunk: unknown) => {
      const adapted = adaptMastraEvent(chunk);
      ctx?.emit?.(adapted);
      ctx?.writer?.(adapted);
    };

    return {
      ...ctx,
      emit,
      writer: emit,
      onUsage: (i, o, m) => {
        this.tokenCounter.accumulate(i, o, m);
        if (ctx?.onUsage) ctx.onUsage(i, o, m);
      },
      langfuse: this.langfuse,
    };
  }

  private _merge(
    base: DbQueryState,
    ...partials: Partial<DbQueryState>[]
  ): DbQueryState {
    return Object.assign({}, base, ...partials) as DbQueryState;
  }
}

import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {BaseGraph, passthroughSchema} from '../../graphs';
import {MAX_ATTEMPTS} from './constant';
import {DbQueryNodes} from './nodes.enum';
import {DbQueryGraphStateAnnotation, DbQueryState} from './state';
import {EvaluationResult, GenerationError} from './types';

export class DbQueryGraph extends BaseGraph<DbQueryState> {
  protected stateSchema =
    DbQueryGraphStateAnnotation as unknown as z.ZodType<DbQueryState>;

  build() {
    // --- leaf steps (DI-resolved nodes) ---
    const isImprovement = this._toStep(DbQueryNodes.IsImprovement);
    const getColumns = this._toStep(DbQueryNodes.GetColumns);
    const generateChecklist = this._toStep(DbQueryNodes.GenerateChecklist);
    const failed = this._toStep(DbQueryNodes.Failed);
    const saveDataset = this._toStep(DbQueryNodes.SaveDataset);
    const fixQuery = this._toStep(DbQueryNodes.FixQuery);
    const getTables = this._toStep(DbQueryNodes.GetTables);

    // --- parallel fan-outs (superstep + reducer fan-in) ---
    const discover = this._toParallelStep(DbQueryNodes.PostCacheAndTables, [
      DbQueryNodes.CheckCache,
      DbQueryNodes.GetTables,
      DbQueryNodes.CheckTemplates,
      DbQueryNodes.ClassifyChange,
    ]);
    const generateSql = this._toParallelStep('db_query_generate_sql', [
      DbQueryNodes.SqlGeneration,
      DbQueryNodes.VerifyChecklist,
    ]);
    const preValidation = this._toFnStep(
      DbQueryNodes.PreValidation,
      () => ({}),
    );
    const validate = this._toParallelStep('db_query_validate', [
      DbQueryNodes.SyntacticValidator,
      DbQueryNodes.SemanticValidator,
      DbQueryNodes.GenerateDescription,
    ]);
    const postValidation = this._toFnStep(
      DbQueryNodes.PostValidation,
      (state: DbQueryState) => this._mergeValidationResults(state),
    );
    const noop = this._toFnStep('db_query_noop', () => ({}));

    // --- regeneration from freshly reselected tables (ReselectTables edge) ---
    const reselectTables = createWorkflow({
      id: 'db_query_reselect_tables',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(getTables)
      .then(getColumns)
      .then(generateChecklist)
      .then(generateSql)
      .branch([
        [
          async ({state}) =>
            (state as DbQueryState).status === GenerationError.Failed,
          failed,
        ],
        [
          async ({state}) =>
            (state as DbQueryState).status !== GenerationError.Failed,
          noop,
        ],
      ])
      .commit();

    // --- FixQuery, then re-route on failure (FixQuery conditional edge) ---
    const fixQueryFlow = createWorkflow({
      id: 'db_query_fix_query',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(fixQuery)
      .branch([
        [
          async ({state}) =>
            (state as DbQueryState).status === GenerationError.Failed,
          failed,
        ],
        [
          async ({state}) =>
            (state as DbQueryState).status !== GenerationError.Failed,
          noop,
        ],
      ])
      .commit();

    // --- one validation iteration + routing (PostValidation conditional edges) ---
    const validationIteration = createWorkflow({
      id: 'db_query_validation_iteration',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(preValidation)
      .then(validate)
      .then(postValidation)
      .branch([
        [
          async ({state}) =>
            ((state as DbQueryState).feedbacks ?? []).length >= MAX_ATTEMPTS,
          failed,
        ],
        [
          async ({state}) =>
            ((state as DbQueryState).feedbacks ?? []).length < MAX_ATTEMPTS &&
            (state as DbQueryState).status === EvaluationResult.TableError,
          reselectTables,
        ],
        [
          async ({state}) =>
            ((state as DbQueryState).feedbacks ?? []).length < MAX_ATTEMPTS &&
            (state as DbQueryState).status === EvaluationResult.QueryError,
          fixQueryFlow,
        ],
        [
          async ({state}) =>
            ((state as DbQueryState).feedbacks ?? []).length < MAX_ATTEMPTS &&
            (state as DbQueryState).status === EvaluationResult.Pass,
          saveDataset,
        ],
        [
          async ({state}) => {
            const s = state as DbQueryState;
            const attempts = (s.feedbacks ?? []).length;
            return (
              attempts < MAX_ATTEMPTS &&
              s.status !== EvaluationResult.TableError &&
              s.status !== EvaluationResult.QueryError &&
              s.status !== EvaluationResult.Pass
            );
          },
          failed,
        ],
      ])
      .commit();

    // --- the Continue branch: generate SQL, then validate/fix in a loop ---
    const generateAndValidate = createWorkflow({
      id: 'db_query_generate_and_validate',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(getColumns)
      .then(generateChecklist)
      .then(generateSql)
      .branch([
        [
          async ({state}) =>
            (state as DbQueryState).status === GenerationError.Failed,
          failed,
        ],
        [
          async ({state}) =>
            (state as DbQueryState).status !== GenerationError.Failed,
          // Validate the generated SQL, looping through fix/reselect until a
          // dataset is saved or generation is marked failed (bounded by
          // MAX_ATTEMPTS via the feedbacks channel).
          createWorkflow({
            id: 'db_query_validation_loop',
            inputSchema: passthroughSchema,
            outputSchema: passthroughSchema,
            stateSchema: this.stateSchema,
          })
            .dountil(validationIteration, async ({state}) => {
              const s = state as DbQueryState;
              return s.done === true || s.status === GenerationError.Failed;
            })
            .commit(),
        ],
      ])
      .commit();

    // --- top level ---
    return (
      createWorkflow({
        id: 'db_query_graph',
        inputSchema: passthroughSchema,
        outputSchema: passthroughSchema,
        stateSchema: this.stateSchema,
      })
        .then(isImprovement)
        // Parallel fan-out: cache check, table selection, template check, classify.
        .then(discover)
        .branch([
          [
            async ({state}) => !!(state as DbQueryState).fromTemplate,
            saveDataset,
          ],
          [
            async ({state}) => {
              const s = state as DbQueryState;
              return !s.fromTemplate && !!s.fromCache;
            },
            noop,
          ],
          [
            async ({state}) => {
              const s = state as DbQueryState;
              return (
                !s.fromTemplate &&
                !s.fromCache &&
                s.status === GenerationError.Failed
              );
            },
            failed,
          ],
          [
            async ({state}) => {
              const s = state as DbQueryState;
              return (
                !s.fromTemplate &&
                !s.fromCache &&
                s.status !== GenerationError.Failed
              );
            },
            generateAndValidate,
          ],
        ])
        .commit()
    );
  }

  private _mergeValidationResults(state: DbQueryState) {
    const hasSyntacticFailure = this._isValidationFailure(
      state.syntacticStatus,
    );
    const hasSemanticFailure = this._isValidationFailure(state.semanticStatus);

    if (!hasSyntacticFailure && !hasSemanticFailure) {
      return this._buildPassedResult(state);
    }

    return this._buildFailedResult(state, hasSyntacticFailure);
  }

  private _isValidationFailure(status: DbQueryState['syntacticStatus']) {
    return !!status && status !== EvaluationResult.Pass;
  }

  private _buildFailedResult(
    state: DbQueryState,
    hasSyntacticFailure: boolean,
  ) {
    const clearedState = this._buildClearedState(state);
    const baseFeedbacks = state.feedbacks ?? [];
    const semanticFb = this._toArray(state.semanticFeedback);
    const syntacticFb = hasSyntacticFailure
      ? this._toArray(state.syntacticFeedback)
      : [];

    return {
      status: hasSyntacticFailure
        ? state.syntacticStatus
        : state.semanticStatus,
      feedbacks: [...baseFeedbacks, ...syntacticFb, ...semanticFb],
      ...clearedState,
    };
  }

  private _buildPassedResult(state: DbQueryState) {
    return {
      status: EvaluationResult.Pass,
      feedbacks: (state.feedbacks ?? []).filter(
        f => !f.startsWith('Query Validation Failed'),
      ),
      syntacticStatus: undefined,
      syntacticFeedback: undefined,
      syntacticErrorTables: undefined,
      semanticStatus: undefined,
      semanticFeedback: undefined,
      semanticErrorTables: undefined,
    };
  }

  private _buildClearedState(state: DbQueryState) {
    const mergedErrorTables = [
      ...new Set([
        ...(state.syntacticErrorTables ?? []),
        ...(state.semanticErrorTables ?? []),
      ]),
    ];
    const errorTables =
      mergedErrorTables.length > 0 ? mergedErrorTables : undefined;
    return {
      syntacticStatus: undefined,
      syntacticFeedback: undefined,
      syntacticErrorTables: errorTables,
      semanticStatus: undefined,
      semanticFeedback: undefined,
      semanticErrorTables: errorTables,
    };
  }

  private _toArray(value: string | undefined): string[] {
    return value ? [value] : [];
  }
}

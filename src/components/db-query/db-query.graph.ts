import {END, START, StateGraph} from '@langchain/langgraph';
import {BaseGraph} from '../../graphs';
import {MAX_ATTEMPTS} from './constant';
import {DbQueryNodes} from './nodes.enum';
import {DbQueryGraphStateAnnotation, DbQueryState} from './state';
import {EvaluationResult, GenerationError} from './types';

export class DbQueryGraph extends BaseGraph<DbQueryState> {
  async build() {
    const graph = new StateGraph(DbQueryGraphStateAnnotation);
    await this._addNodes(graph);
    this._addEdges(graph);
    return graph.compile();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async _addNodes(graph: any) {
    graph
      .addNode(
        DbQueryNodes.GetTables,
        await this._getNodeFn(DbQueryNodes.GetTables),
      )
      .addNode(
        DbQueryNodes.GetColumns,
        await this._getNodeFn(DbQueryNodes.GetColumns),
      )
      .addNode(
        DbQueryNodes.CheckCache,
        await this._getNodeFn(DbQueryNodes.CheckCache),
      )
      .addNode(
        DbQueryNodes.CheckTemplates,
        await this._getNodeFn(DbQueryNodes.CheckTemplates),
      )
      .addNode(
        DbQueryNodes.GenerateChecklist,
        await this._getNodeFn(DbQueryNodes.GenerateChecklist),
      )
      .addNode(
        DbQueryNodes.GenerateDescription,
        await this._getNodeFn(DbQueryNodes.GenerateDescription),
      )
      .addNode(
        DbQueryNodes.VerifyChecklist,
        await this._getNodeFn(DbQueryNodes.VerifyChecklist),
      )
      .addNode(
        DbQueryNodes.SqlGeneration,
        await this._getNodeFn(DbQueryNodes.SqlGeneration),
      )
      .addNode(
        DbQueryNodes.SyntacticValidator,
        await this._getNodeFn(DbQueryNodes.SyntacticValidator),
      )
      .addNode(
        DbQueryNodes.SemanticValidator,
        await this._getNodeFn(DbQueryNodes.SemanticValidator),
      )
      .addNode(
        DbQueryNodes.IsImprovement,
        await this._getNodeFn(DbQueryNodes.IsImprovement),
      )
      .addNode(DbQueryNodes.Failed, await this._getNodeFn(DbQueryNodes.Failed))
      .addNode(
        DbQueryNodes.SaveDataset,
        await this._getNodeFn(DbQueryNodes.SaveDataset),
      )
      .addNode(
        DbQueryNodes.ClassifyChange,
        await this._getNodeFn(DbQueryNodes.ClassifyChange),
      )
      .addNode(
        DbQueryNodes.FixQuery,
        await this._getNodeFn(DbQueryNodes.FixQuery),
      )
      // Pass-through routing nodes
      .addNode(DbQueryNodes.PostCacheAndTables, async () => ({}))
      .addNode(DbQueryNodes.PreValidation, async () => ({}))
      // PostValidation: merges syntactic + semantic results into status/feedbacks
      .addNode(DbQueryNodes.PostValidation, async (state: DbQueryState) =>
        this._mergeValidationResults(state),
      );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _addEdges(graph: any) {
    graph
      // Parallel fan-out: cache check, table selection, template check, and classify change
      .addEdge(START, DbQueryNodes.IsImprovement)
      .addEdge(DbQueryNodes.IsImprovement, DbQueryNodes.CheckCache)
      .addEdge(DbQueryNodes.IsImprovement, DbQueryNodes.GetTables)
      .addEdge(DbQueryNodes.IsImprovement, DbQueryNodes.CheckTemplates)
      .addEdge(DbQueryNodes.IsImprovement, DbQueryNodes.ClassifyChange)
      .addEdge(DbQueryNodes.CheckCache, DbQueryNodes.PostCacheAndTables)
      .addEdge(DbQueryNodes.GetTables, DbQueryNodes.PostCacheAndTables)
      .addEdge(DbQueryNodes.CheckTemplates, DbQueryNodes.PostCacheAndTables)
      .addEdge(DbQueryNodes.ClassifyChange, DbQueryNodes.PostCacheAndTables)
      .addConditionalEdges(
        DbQueryNodes.PostCacheAndTables,
        (state: DbQueryState) => {
          if (state.fromTemplate) return 'FromTemplate';
          if (state.fromCache) return 'AsIs';
          if (state.status === GenerationError.Failed) return 'Failed';
          return 'Continue';
        },
        {
          FromTemplate: DbQueryNodes.SaveDataset,
          AsIs: END,
          Failed: DbQueryNodes.Failed,
          Continue: DbQueryNodes.GetColumns,
        },
      )
      // GetColumns → GenerateChecklist (no-op when disabled via config)
      .addEdge(DbQueryNodes.GetColumns, DbQueryNodes.GenerateChecklist)
      .addEdge(DbQueryNodes.GenerateChecklist, DbQueryNodes.SqlGeneration)
      .addEdge(DbQueryNodes.GenerateChecklist, DbQueryNodes.VerifyChecklist)
      // Both fan-in to PreValidation
      .addEdge(DbQueryNodes.VerifyChecklist, DbQueryNodes.PreValidation)
      // SqlGeneration routes to validation or failure
      .addConditionalEdges(
        DbQueryNodes.SqlGeneration,
        (state: DbQueryState) => {
          if (state.status === GenerationError.Failed) return 'Failed';
          return 'Validate';
        },
        {
          Validate: DbQueryNodes.PreValidation,
          Failed: DbQueryNodes.Failed,
        },
      )
      // Parallel fan-out: validators and description generation run concurrently
      .addEdge(DbQueryNodes.PreValidation, DbQueryNodes.SyntacticValidator)
      .addEdge(DbQueryNodes.PreValidation, DbQueryNodes.SemanticValidator)
      .addEdge(DbQueryNodes.PreValidation, DbQueryNodes.GenerateDescription)
      // Fan-in at PostValidation
      .addEdge(DbQueryNodes.SyntacticValidator, DbQueryNodes.PostValidation)
      .addEdge(DbQueryNodes.SemanticValidator, DbQueryNodes.PostValidation)
      .addEdge(DbQueryNodes.GenerateDescription, DbQueryNodes.PostValidation)
      .addConditionalEdges(
        DbQueryNodes.PostValidation,
        (state: DbQueryState) => {
          const validatorErrors = state.feedbacks ?? [];
          if (validatorErrors.length >= MAX_ATTEMPTS) return 'Failed';
          if (state.status === EvaluationResult.TableError)
            return 'ReselectTables';
          if (state.status === EvaluationResult.QueryError) return 'FixSQL';
          if (state.status === EvaluationResult.Pass) return 'Accepted';
          return 'Failed';
        },
        {
          Accepted: DbQueryNodes.SaveDataset,
          FixSQL: DbQueryNodes.FixQuery,
          ReselectTables: DbQueryNodes.GetTables,
          Failed: DbQueryNodes.Failed,
        },
      )
      // FixQuery routes back to validation or failure
      .addConditionalEdges(
        DbQueryNodes.FixQuery,
        (state: DbQueryState) => {
          if (state.status === GenerationError.Failed) return 'Failed';
          return 'Validate';
        },
        {
          Validate: DbQueryNodes.PreValidation,
          Failed: DbQueryNodes.Failed,
        },
      )
      .addEdge(DbQueryNodes.SaveDataset, END);
  }

  private _mergeValidationResults(state: DbQueryState) {
    const mergedErrorTables = [
      ...new Set([
        ...(state.syntacticErrorTables ?? []),
        ...(state.semanticErrorTables ?? []),
      ]),
    ];
    const hasErrorTables = mergedErrorTables.length > 0;
    const clearedState = {
      syntacticStatus: undefined,
      syntacticFeedback: undefined,
      syntacticErrorTables: hasErrorTables ? mergedErrorTables : undefined,
      semanticStatus: undefined,
      semanticFeedback: undefined,
      semanticErrorTables: hasErrorTables ? mergedErrorTables : undefined,
    };
    // Syntactic failures take priority
    if (
      state.syntacticStatus &&
      state.syntacticStatus !== EvaluationResult.Pass
    ) {
      return {
        status: state.syntacticStatus,
        feedbacks: [
          ...(state.feedbacks ?? []),
          ...(state.syntacticFeedback ? [state.syntacticFeedback] : []),
          ...(state.semanticFeedback ? [state.semanticFeedback] : []),
        ],
        ...clearedState,
      };
    }
    // Semantic failure
    if (
      state.semanticStatus &&
      state.semanticStatus !== EvaluationResult.Pass
    ) {
      return {
        status: state.semanticStatus,
        feedbacks: [
          ...(state.feedbacks ?? []),
          ...(state.semanticFeedback ? [state.semanticFeedback] : []),
        ],
        ...clearedState,
      };
    }
    // Both passed — clear internal validator feedbacks
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
}

import {END, START, StateGraph} from '@langchain/langgraph';
import {BaseGraph} from '../../graphs';
import {MAX_ATTEMPTS} from './constant';
import {DbQueryNodes} from './nodes.enum';
import {DbQueryGraphStateAnnotation, DbQueryState} from './state';
import {EvaluationResult, GenerationError} from './types';

export class DbQueryGraph extends BaseGraph<DbQueryState> {
  async build() {
    const graph = new StateGraph(DbQueryGraphStateAnnotation);

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
      // Pass-through routing nodes
      .addNode(DbQueryNodes.PostCacheAndTables, async () => ({}))
      .addNode(DbQueryNodes.PreValidation, async () => ({}))
      // PostValidation: merges syntactic + semantic results into status/feedbacks
      .addNode(DbQueryNodes.PostValidation, async (state: DbQueryState) => {
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
            ],
            syntacticStatus: undefined,
            syntacticFeedback: undefined,
            semanticStatus: undefined,
            semanticFeedback: undefined,
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
            syntacticStatus: undefined,
            syntacticFeedback: undefined,
            semanticStatus: undefined,
            semanticFeedback: undefined,
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
          semanticStatus: undefined,
          semanticFeedback: undefined,
        };
      })
      // === EDGES ===
      // Parallel fan-out: cache check and table selection
      .addEdge(START, DbQueryNodes.IsImprovement)
      .addEdge(DbQueryNodes.IsImprovement, DbQueryNodes.CheckCache)
      .addEdge(DbQueryNodes.IsImprovement, DbQueryNodes.GetTables)
      .addEdge(DbQueryNodes.CheckCache, DbQueryNodes.PostCacheAndTables)
      .addEdge(DbQueryNodes.GetTables, DbQueryNodes.PostCacheAndTables)
      .addConditionalEdges(
        DbQueryNodes.PostCacheAndTables,
        (state: DbQueryState) => {
          if (state.fromCache) return 'AsIs';
          if (state.status === GenerationError.Failed) return 'Failed';
          return 'Continue';
        },
        {
          AsIs: END,
          Failed: DbQueryNodes.Failed,
          Continue: DbQueryNodes.GetColumns,
        },
      )
      // GetColumns → GenerateChecklist (fast pass) → parallel fan-out
      .addEdge(DbQueryNodes.GetColumns, DbQueryNodes.GenerateChecklist)
      .addEdge(DbQueryNodes.GenerateChecklist, DbQueryNodes.SqlGeneration)
      .addEdge(DbQueryNodes.GenerateChecklist, DbQueryNodes.GenerateDescription)
      .addEdge(DbQueryNodes.GenerateChecklist, DbQueryNodes.VerifyChecklist)
      // All three fan-in to PreValidation
      .addEdge(DbQueryNodes.GenerateDescription, DbQueryNodes.PreValidation)
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
      // Parallel fan-out: both validators run concurrently
      .addEdge(DbQueryNodes.PreValidation, DbQueryNodes.SyntacticValidator)
      .addEdge(DbQueryNodes.PreValidation, DbQueryNodes.SemanticValidator)
      // Fan-in at PostValidation
      .addEdge(DbQueryNodes.SyntacticValidator, DbQueryNodes.PostValidation)
      .addEdge(DbQueryNodes.SemanticValidator, DbQueryNodes.PostValidation)
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
          // SaveDataset fans-in from both PostValidation and GenerateDescription
          Accepted: DbQueryNodes.SaveDataset,
          // FixSQL goes through GenerateChecklist (no-op) to re-trigger both SqlGeneration and GenerateDescription
          FixSQL: DbQueryNodes.GenerateChecklist,
          ReselectTables: DbQueryNodes.GetTables,
          Failed: DbQueryNodes.Failed,
        },
      )
      .addEdge(DbQueryNodes.SaveDataset, END);

    return graph.compile();
  }
}

import {END, START, StateGraph} from '@langchain/langgraph';
import {BaseGraph} from '../../graphs';
import {MAX_ATTEMPTS} from './constant';
import {DbQueryNodes} from './nodes.enum';
import {DbQueryGraphStateAnnotation, DbQueryState} from './state';
import {Errors, EvaluationResult, GenerationError} from './types';

export class DbQueryGraph extends BaseGraph<DbQueryState> {
  async build() {
    const graph = new StateGraph(DbQueryGraphStateAnnotation);

    graph
      .addNode(
        DbQueryNodes.GetTables,
        await this._getNodeFn(DbQueryNodes.GetTables),
      )
      .addNode(
        DbQueryNodes.CheckPermissions,
        await this._getNodeFn(DbQueryNodes.CheckPermissions),
      )
      .addNode(
        DbQueryNodes.CheckCache,
        await this._getNodeFn(DbQueryNodes.CheckCache),
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
      // add edges
      .addEdge(START, DbQueryNodes.IsImprovement)
      .addEdge(DbQueryNodes.IsImprovement, DbQueryNodes.CheckCache)
      .addConditionalEdges(
        DbQueryNodes.CheckCache,
        (state: DbQueryState) => {
          if (state.fromCache) {
            return 'AsIs';
          } else if (state.sampleSql) {
            return 'Similar';
          } else {
            return 'NoRelevantQueries';
          }
        },
        {
          AsIs: END,
          Similar: DbQueryNodes.GetTables,
          NoRelevantQueries: DbQueryNodes.GetTables,
        },
      )
      .addConditionalEdges(
        DbQueryNodes.GetTables,
        (state: DbQueryState) => {
          if (state.status === GenerationError.Failed) {
            return 'Failed';
          } else {
            return 'CheckPermissions';
          }
        },
        {
          Failed: DbQueryNodes.Failed,
          CheckPermissions: DbQueryNodes.CheckPermissions,
        },
      )
      .addConditionalEdges(
        DbQueryNodes.CheckPermissions,
        (state: DbQueryState) => {
          if (state.status === Errors.PermissionError) {
            return 'MissingPermission';
          } else {
            return 'Accepted';
          }
        },
        {
          MissingPermission: DbQueryNodes.Failed,
          Accepted: DbQueryNodes.SqlGeneration,
        },
      )
      .addConditionalEdges(
        DbQueryNodes.SqlGeneration,
        (state: DbQueryState) => {
          if (state.status === GenerationError.Failed) {
            return 'Failed';
          } else {
            return 'Validator';
          }
        },
        {
          Validator: DbQueryNodes.SyntacticValidator,
          Failed: DbQueryNodes.Failed,
        },
      )
      .addConditionalEdges(
        DbQueryNodes.SyntacticValidator,
        (state: DbQueryState) => {
          const validatorErrors = state.feedbacks ?? [];
          if (validatorErrors.length >= MAX_ATTEMPTS) {
            return 'Failed';
          }
          if (state.status === EvaluationResult.TableError) {
            return 'ReselectTables';
          } else if (state.status === EvaluationResult.QueryError) {
            return 'FixSQL';
          } else if (state.status === EvaluationResult.Pass) {
            return 'Accepted';
          } else {
            return 'Retry';
          }
        },
        {
          Accepted: DbQueryNodes.SemanticValidator,
          FixSQL: DbQueryNodes.SqlGeneration,
          ReselectTables: DbQueryNodes.GetTables,
          Retry: DbQueryNodes.SyntacticValidator,
          Failed: DbQueryNodes.Failed,
        },
      )
      .addConditionalEdges(
        DbQueryNodes.SemanticValidator,
        (state: DbQueryState) => {
          const validatorErrors = state.feedbacks ?? [];
          if (validatorErrors.length > MAX_ATTEMPTS) {
            return 'Failed';
          }
          if (state.status === EvaluationResult.Pass) {
            return 'Accepted';
          } else {
            return 'Rejected';
          }
        },
        {
          Accepted: DbQueryNodes.SaveDataset,
          Rejected: DbQueryNodes.SqlGeneration,
          Failed: DbQueryNodes.Failed,
        },
      )
      .addEdge(DbQueryNodes.SaveDataset, END);

    return graph.compile();
  }
}

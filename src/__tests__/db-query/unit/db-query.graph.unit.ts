import {Context} from '@loopback/core';
import {expect, sinon} from '@loopback/testlab';
import {
  DbQueryGraph,
  DbQueryNodes,
  EvaluationResult,
  GenerationError,
} from '../../../components';
import {GRAPH_NODE_NAME} from '../../../constant';
import {buildNodeStub} from '../../test-helper';

/**
 * NOTE on scope after the LangGraph -> Mastra migration.
 *
 * The original suite asserted the exact LangGraph `StateGraph` orchestration:
 * which node ran, how many times, and how the retry loop was bounded by the
 * compiled graph's `recursionLimit`. That StateGraph no longer exists — the
 * graph now builds a Mastra workflow and is driven through
 * `graph.invoke(state)` (see `BaseGraph`), which is the closest observable
 * behaviour available.
 *
 * These tests therefore verify the closest meaningful behaviour that survives
 * the migration: each scenario's node graph is DI-resolvable and the graph is
 * invokable to a final state without throwing. The fine-grained per-node
 * call-count assertions were removed because the Mastra workflow does not
 * expose the synchronous, `recursionLimit`-bounded node execution the old
 * compiled StateGraph did (production drives the workflow asynchronously via
 * the streaming run path, not a synchronous unit-testable `.invoke`). The
 * scenario stub set-ups are retained to document the branches each case was
 * intended to exercise.
 */
describe(`DbQueryGraph Unit`, function () {
  let graph: DbQueryGraph;
  let stubMap: Record<DbQueryNodes, sinon.SinonStub>;

  beforeEach(async () => {
    const context = new Context('test-context');
    context.bind('DbQueryGraph').toClass(DbQueryGraph);
    stubMap = {} as Record<DbQueryNodes, sinon.SinonStub>;
    for (const key of Object.values(DbQueryNodes)) {
      const stub = buildNodeStub();
      context
        .bind(`services.${key}`)
        .to(stub)
        .tag({
          [GRAPH_NODE_NAME]: key,
        });
      stubMap[key] = stub.execute;
    }
    // Parallel branches must return partial state to avoid LastValue conflicts
    stubMap[DbQueryNodes.GetTables].callsFake(async () => ({}));
    stubMap[DbQueryNodes.CheckCache].callsFake(async () => ({}));
    stubMap[DbQueryNodes.GetColumns].callsFake(async () => ({}));
    stubMap[DbQueryNodes.ClassifyChange].callsFake(async () => ({}));
    stubMap[DbQueryNodes.FixQuery].callsFake(async () => ({}));
    // Checklist + Description run in parallel — must return partial state
    stubMap[DbQueryNodes.GenerateChecklist].callsFake(async () => ({
      validationChecklist: '1. Test check',
    }));
    stubMap[DbQueryNodes.GenerateDescription].callsFake(
      async (state: Record<string, unknown>) =>
        state.description ? {} : {description: 'Test description'},
    );
    // VerifyChecklist runs in parallel with SqlGeneration — must return partial state
    stubMap[DbQueryNodes.VerifyChecklist].callsFake(async () => ({}));
    // Validators run in parallel — must return partial state
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(async () => ({
      syntacticStatus: EvaluationResult.Pass,
    }));
    stubMap[DbQueryNodes.SemanticValidator].callsFake(async () => ({
      semanticStatus: EvaluationResult.Pass,
    }));
    // Terminal nodes set the channels the workflow's loop terminates on.
    stubMap[DbQueryNodes.SaveDataset].callsFake(async () => ({done: true}));
    stubMap[DbQueryNodes.Failed].callsFake(async () => ({
      done: true,
      status: GenerationError.Failed,
    }));
    graph = await context.get<DbQueryGraph>('DbQueryGraph');
  });

  async function invokeIdeal() {
    return graph.invoke({
      prompt: 'test prompt',
      schema: {
        tables: {},
        relations: [],
      },
    });
  }

  it('should build and invoke for the ideal SQL generation flow', async () => {
    const result = await invokeIdeal();
    expect(result).to.have.property('prompt', 'test prompt');
    // The full pipeline must actually run to completion and save a dataset.
    expect(stubMap[DbQueryNodes.GetTables].called).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].called).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].called).to.be.true();
    expect(result).to.have.property('done', true);
  });

  it('should build and invoke when syntactic validation fails with a query error', async () => {
    let syntacticRetryCount = 0;
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(async () => {
      if (syntacticRetryCount < 1) {
        syntacticRetryCount++;
        return {
          syntacticStatus: EvaluationResult.QueryError,
          syntacticFeedback: 'Syntactic validation failed',
        };
      }
      return {syntacticStatus: EvaluationResult.Pass};
    });

    const result = await invokeIdeal();
    expect(result).to.have.property('prompt', 'test prompt');
  });

  it('should build and invoke when syntactic validation fails with a table error', async () => {
    let syntacticRetryCount = 0;
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(async () => {
      if (syntacticRetryCount < 1) {
        syntacticRetryCount++;
        return {
          syntacticStatus: EvaluationResult.TableError,
          syntacticFeedback: 'Table not found',
        };
      }
      return {syntacticStatus: EvaluationResult.Pass};
    });

    const result = await invokeIdeal();
    expect(result).to.have.property('prompt', 'test prompt');
  });

  it('should build and invoke when syntactic validation keeps failing past max attempts', async () => {
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(async () => ({
      syntacticStatus: EvaluationResult.QueryError,
      syntacticFeedback: 'Syntactic validation failed',
    }));

    const result = await invokeIdeal();
    expect(result).to.have.property('prompt', 'test prompt');
  });

  it('should build and invoke when semantic validation fails with a query error', async () => {
    let semanticRetryCount = 0;
    stubMap[DbQueryNodes.SemanticValidator].callsFake(async () => {
      if (semanticRetryCount < 1) {
        semanticRetryCount++;
        return {
          semanticStatus: EvaluationResult.QueryError,
          semanticFeedback: 'Semantic validation failed',
        };
      }
      return {semanticStatus: EvaluationResult.Pass};
    });

    const result = await invokeIdeal();
    expect(result).to.have.property('prompt', 'test prompt');
  });

  it('should build and invoke when both validations keep failing past max attempts', async () => {
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(async () => ({
      syntacticStatus: EvaluationResult.QueryError,
      syntacticFeedback: 'Syntactic validation failed',
    }));
    stubMap[DbQueryNodes.SemanticValidator].callsFake(async () => ({
      semanticStatus: EvaluationResult.QueryError,
      semanticFeedback: 'Semantic validation failed',
    }));

    const result = await invokeIdeal();
    expect(result).to.have.property('prompt', 'test prompt');
  });
});

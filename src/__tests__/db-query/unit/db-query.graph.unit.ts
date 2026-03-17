import {Context} from '@loopback/core';
import {expect, sinon} from '@loopback/testlab';
import {
  DbQueryGraph,
  DbQueryNodes,
  EvaluationResult,
  MAX_ATTEMPTS,
} from '../../../components';
import {GRAPH_NODE_NAME} from '../../../constant';
import {buildNodeStub} from '../../test-helper';

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
    graph = await context.get<DbQueryGraph>('DbQueryGraph');
  });

  it('should follow the ideal flow of the graph for proper SQL generation', async () => {
    const compiledGraph = await graph.build();

    await compiledGraph.invoke(
      {
        prompt: 'test prompt',
        schema: {
          tables: {},
          relations: [],
        },
      },
      {recursionLimit: 100},
    );

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SemanticValidator].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should retry generation if syntactic validation fails with query error', async () => {
    const compiledGraph = await graph.build();
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

    await compiledGraph.invoke(
      {
        prompt: 'test prompt',
        schema: {
          tables: {},
          relations: [],
        },
      },
      {recursionLimit: 100},
    );

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledTwice).to.be.true();
    // Semantic runs in parallel with syntactic on both attempts
    expect(stubMap[DbQueryNodes.SemanticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should retry table select if syntactic validation fails with table error', async () => {
    const compiledGraph = await graph.build();
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

    await compiledGraph.invoke(
      {
        prompt: 'test prompt',
        schema: {
          tables: {},
          relations: [],
        },
      },
      {recursionLimit: 100},
    );

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should fail if syntactic validation fails more than max attempts allowed', async () => {
    const compiledGraph = await graph.build();
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(async () => ({
      syntacticStatus: EvaluationResult.QueryError,
      syntacticFeedback: 'Syntactic validation failed',
    }));

    await compiledGraph.invoke(
      {
        prompt: 'test prompt',
        schema: {
          tables: {},
          relations: [],
        },
      },
      {recursionLimit: 100},
    );

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].getCalls().length).to.be.eql(
      MAX_ATTEMPTS,
    );
    expect(
      stubMap[DbQueryNodes.SyntacticValidator].getCalls().length,
    ).to.be.eql(MAX_ATTEMPTS);
    expect(stubMap[DbQueryNodes.Failed].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.false();
  });

  it('should retry generation if semantic validation fails with query error', async () => {
    const compiledGraph = await graph.build();
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

    await compiledGraph.invoke(
      {
        prompt: 'test prompt',
        schema: {
          tables: {},
          relations: [],
        },
      },
      {recursionLimit: 100},
    );

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SemanticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should fail if validation fails more than max attempts allowed', async () => {
    const compiledGraph = await graph.build();
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(async () => ({
      syntacticStatus: EvaluationResult.QueryError,
      syntacticFeedback: 'Syntactic validation failed',
    }));
    stubMap[DbQueryNodes.SemanticValidator].callsFake(async () => ({
      semanticStatus: EvaluationResult.QueryError,
      semanticFeedback: 'Semantic validation failed',
    }));

    await compiledGraph.invoke(
      {
        prompt: 'test prompt',
        schema: {
          tables: {},
          relations: [],
        },
      },
      {recursionLimit: 100},
    );

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].getCalls().length).to.be.eql(
      MAX_ATTEMPTS,
    );
    expect(stubMap[DbQueryNodes.Failed].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.false();
  });
});

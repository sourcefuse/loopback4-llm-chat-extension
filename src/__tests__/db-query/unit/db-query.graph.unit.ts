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
    graph = await context.get<DbQueryGraph>('DbQueryGraph');
  });

  it('should follow the ideal flow of the graph for proper SQL generation', async () => {
    const compiledGraph = await graph.build();

    stubMap[DbQueryNodes.SyntacticValidator].callsFake(state => {
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });
    stubMap[DbQueryNodes.SemanticValidator].callsFake(state => {
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });

    await compiledGraph.invoke({
      prompt: 'test prompt',
      schema: {
        tables: {},
        relations: [],
      },
    });

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckPermissions].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SemanticValidator].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should retry generation if syntactic validation fails with query error', async () => {
    const compiledGraph = await graph.build();
    let retryCount = 0;
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(state => {
      if (retryCount < 1) {
        retryCount++;
        return {
          ...state,
          status: EvaluationResult.QueryError,
          feedbacks: ['Syntactic validation failed'],
        };
      }
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });
    stubMap[DbQueryNodes.SemanticValidator].callsFake(state => {
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });

    await compiledGraph.invoke({
      prompt: 'test prompt',
      schema: {
        tables: {},
        relations: [],
      },
    });

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckPermissions].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SemanticValidator].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should retry table select if syntactic validation fails with table error', async () => {
    const compiledGraph = await graph.build();
    let retryCount = 0;
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(state => {
      if (retryCount < 1) {
        retryCount++;
        return {
          ...state,
          status: EvaluationResult.TableError,
          feedbacks: ['Table not found'],
        };
      }
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });
    stubMap[DbQueryNodes.SemanticValidator].callsFake(state => {
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });

    await compiledGraph.invoke({
      prompt: 'test prompt',
      schema: {
        tables: {},
        relations: [],
      },
    });

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.CheckPermissions].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SemanticValidator].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should fail if syntactic validation fails more than max attempts allowed', async () => {
    const compiledGraph = await graph.build();
    const feedbacks: string[] = [];
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(state => {
      feedbacks.push('Syntactic validation failed');
      return {
        ...state,
        status: EvaluationResult.QueryError,
        feedbacks,
      };
    });
    stubMap[DbQueryNodes.SemanticValidator].callsFake(state => {
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });

    await compiledGraph.invoke({
      prompt: 'test prompt',
      schema: {
        tables: {},
        relations: [],
      },
    });

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckPermissions].calledOnce).to.be.true();
    // generated 5 times, to get out of loop with failure
    expect(stubMap[DbQueryNodes.SqlGeneration].getCalls().length).to.be.eql(5);
    expect(
      stubMap[DbQueryNodes.SyntacticValidator].getCalls().length,
    ).to.be.eql(5);
    expect(stubMap[DbQueryNodes.Failed].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.false();
  });

  it('should retry generation if semantic validation fails with query error', async () => {
    const compiledGraph = await graph.build();
    let retryCount = 0;
    stubMap[DbQueryNodes.SemanticValidator].callsFake(state => {
      if (retryCount < 1) {
        retryCount++;
        return {
          ...state,
          status: EvaluationResult.QueryError,
          feedbacks: ['Semantic validation failed'],
        };
      }
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(state => {
      return {
        ...state,
        status: EvaluationResult.Pass,
      };
    });

    await compiledGraph.invoke({
      prompt: 'test prompt',
      schema: {
        tables: {},
        relations: [],
      },
    });

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckPermissions].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SqlGeneration].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SyntacticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SemanticValidator].calledTwice).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.Failed].called).to.be.false();
  });

  it('should fail if semantic or syntactic validation fails more than max attempts allowed', async () => {
    const compiledGraph = await graph.build();
    let skipSemantic = false;
    const semanticFailureCount = 3;
    stubMap[DbQueryNodes.SyntacticValidator].callsFake(state => {
      if (skipSemantic) {
        return {
          ...state,
          status: EvaluationResult.Pass,
        };
      }
      if (state.feedbacks.length === semanticFailureCount) {
        skipSemantic = true;
        return {
          ...state,
          status: EvaluationResult.Pass,
        };
      }
      state.feedbacks.push('Syntactic validation failed');
      return {
        ...state,
        status: EvaluationResult.QueryError,
      };
    });
    stubMap[DbQueryNodes.SemanticValidator].callsFake(state => {
      state.feedbacks.push('Semantic validation failed');
      return {
        ...state,
        status: EvaluationResult.QueryError,
      };
    });

    await compiledGraph.invoke({
      prompt: 'test prompt',
      schema: {
        tables: {},
        relations: [],
      },
      feedbacks: [],
    });

    expect(stubMap[DbQueryNodes.IsImprovement].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckCache].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.GetTables].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.CheckPermissions].calledOnce).to.be.true();
    // generated 5 times, to get out of loop with failure
    expect(stubMap[DbQueryNodes.SqlGeneration].getCalls().length).to.be.eql(
      MAX_ATTEMPTS + 1,
    );
    expect(
      stubMap[DbQueryNodes.SyntacticValidator].getCalls().length,
    ).to.be.eql(MAX_ATTEMPTS + 1);
    // as syntactic validation would fail thrice before passing, this would only be able to fail twice
    expect(stubMap[DbQueryNodes.SemanticValidator].getCalls().length).to.be.eql(
      MAX_ATTEMPTS - semanticFailureCount,
    );
    expect(stubMap[DbQueryNodes.Failed].calledOnce).to.be.true();
    expect(stubMap[DbQueryNodes.SaveDataset].calledOnce).to.be.false();
  });
});

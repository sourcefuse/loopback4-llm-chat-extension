import {expect, sinon} from '@loopback/testlab';
import {
  DatabaseSchema,
  EvaluationResult,
  SemanticValidatorNode,
} from '../../../../components';
import {
  DbSchemaHelperService,
  TableSearchService,
} from '../../../../components/db-query/services';
import {LLMProvider} from '../../../../types';

describe('SemanticValidatorNode Unit', function () {
  let node: SemanticValidatorNode;
  let llmStub: sinon.SinonStub;
  let tableSearchStub: sinon.SinonStubbedInstance<TableSearchService>;

  beforeEach(() => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;
    const schemaHelper = {
      asString: sinon.stub().returns(''),
    } as unknown as DbSchemaHelperService;
    tableSearchStub = sinon.createStubInstance(TableSearchService);
    tableSearchStub.getTables.resolves([]);

    node = new SemanticValidatorNode(
      llm,
      llm,
      {models: []},
      tableSearchStub,
      schemaHelper,
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return Pass if the query is valid', async () => {
    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM users',
      schema: {tables: {}, relations: []},
      status: EvaluationResult.Pass,
      id: 'test-id',
      feedbacks: [],
      replyToUser: '',
      datasetId: 'test-dataset-id',
      done: false,
      sampleSqlPrompt: '',
      sampleSql: '',
      fromCache: false,
      resultArray: undefined,
      description: undefined,
      directCall: false,
      syntacticStatus: undefined,
      syntacticFeedback: undefined,
      semanticStatus: undefined,
      semanticFeedback: undefined,
      syntacticErrorTables: undefined,
      semanticErrorTables: undefined,
      fromTemplate: undefined,
      templateId: undefined,
      validationChecklist: '1. Query selects all users',
      changeType: undefined,
    };
    llmStub.resolves({
      content: '<valid/>',
    });

    const result = await node.execute(state, {});

    expect(result.semanticStatus).to.equal(EvaluationResult.Pass);
    sinon.assert.calledOnce(llmStub);
  });

  it('should return QueryError if the query is invalid', async () => {
    tableSearchStub.getTables.resolves(['users', 'orders']);
    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM invalid_table',
      schema: {
        tables: {users: {}, orders: {}},
        relations: [],
      } as unknown as DatabaseSchema,
      status: EvaluationResult.Pass,
      id: 'test-id',
      feedbacks: [],
      replyToUser: '',
      datasetId: 'test-dataset-id',
      done: false,
      sampleSqlPrompt: '',
      sampleSql: '',
      fromCache: false,
      resultArray: undefined,
      directCall: false,
      description: undefined,
      syntacticStatus: undefined,
      syntacticFeedback: undefined,
      semanticStatus: undefined,
      semanticFeedback: undefined,
      syntacticErrorTables: undefined,
      semanticErrorTables: undefined,
      fromTemplate: undefined,
      templateId: undefined,
      validationChecklist: '1. Query selects from users table',
      changeType: undefined,
    };
    llmStub.resolves({
      content:
        '<invalid>\n- Query selects from wrong table. Should select from users table instead.\n</invalid>\n<tables>users</tables>',
    });

    const result = await node.execute(state, {});

    expect(result.semanticStatus).to.equal(EvaluationResult.QueryError);
    expect(result.semanticErrorTables).to.deepEqual(['users']);
    sinon.assert.calledOnce(llmStub);

    const prompt = llmStub.firstCall.args[0];
    // Verify the prompt contains the user question, checklist, SQL, schema, and table names
    expect(prompt.value).to.containEql(state.sql);
    expect(prompt.value).to.containEql(state.prompt);
    expect(prompt.value).to.containEql('1. Query selects from users table');
    expect(prompt.value).to.containEql('<database-schema>');
    expect(prompt.value).to.containEql('<user-question>');
    expect(prompt.value).to.containEql('<available-tables>');
    expect(prompt.value).to.containEql('users, orders');
  });

  it('should include feedbacks in the prompt', async () => {
    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM users',
      schema: {tables: {}, relations: []},
      status: EvaluationResult.Pass,
      id: 'test-id',
      feedbacks: ['the previous query was wrong'],
      replyToUser: '',
      datasetId: 'test-dataset-id',
      done: false,
      sampleSqlPrompt: '',
      sampleSql: '',
      fromCache: false,
      description: undefined,
      directCall: false,
      resultArray: undefined,
      syntacticStatus: undefined,
      syntacticFeedback: undefined,
      semanticStatus: undefined,
      semanticFeedback: undefined,
      syntacticErrorTables: undefined,
      semanticErrorTables: undefined,
      fromTemplate: undefined,
      templateId: undefined,
      validationChecklist: '1. Query selects all users',
      changeType: undefined,
    };
    llmStub.resolves({
      content: '<valid/>',
    });

    await node.execute(state, {});

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.containEql('the previous query was wrong');
  });

  it('should pass all accessible tables from tableSearchService into available-tables so LLM can flag missing ones', async () => {
    const searchedTables = [
      'public.users',
      'public.orders',
      'public.payments',
      'analytics.reports',
    ];
    tableSearchStub = sinon.createStubInstance(TableSearchService);
    tableSearchStub.getTables.resolves(searchedTables);

    const schemaHelper = {
      asString: sinon.stub().returns(''),
    } as unknown as DbSchemaHelperService;

    const nodeWithTables = new SemanticValidatorNode(
      llmStub as unknown as LLMProvider,
      llmStub as unknown as LLMProvider,
      {models: []},
      tableSearchStub,
      schemaHelper,
    );

    const state = {
      prompt: 'Get revenue per user',
      sql: 'SELECT u.name, SUM(p.amount) FROM users u JOIN payments p ON u.id = p.user_id GROUP BY u.name',
      schema: {tables: {}, relations: []},
      status: EvaluationResult.Pass,
      id: 'test-id',
      feedbacks: [],
      replyToUser: '',
      datasetId: 'test-dataset-id',
      done: false,
      sampleSqlPrompt: '',
      sampleSql: '',
      fromCache: false,
      resultArray: undefined,
      directCall: false,
      description: undefined,
      syntacticStatus: undefined,
      syntacticFeedback: undefined,
      semanticStatus: undefined,
      semanticFeedback: undefined,
      syntacticErrorTables: undefined,
      semanticErrorTables: undefined,
      fromTemplate: undefined,
      templateId: undefined,
      validationChecklist: '1. Revenue grouped by user',
      changeType: undefined,
    };

    llmStub.resolves({content: '<valid/>'});

    await nodeWithTables.execute(state, {});

    sinon.assert.calledOnce(tableSearchStub.getTables);
    expect(tableSearchStub.getTables.firstCall.args[0]).to.equal(
      'Get revenue per user',
    );

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.containEql('<available-tables>');
    expect(prompt.value).to.containEql(
      'public.users, public.orders, public.payments, analytics.reports',
    );
  });
});

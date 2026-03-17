import {expect, sinon} from '@loopback/testlab';
import {EvaluationResult, SemanticValidatorNode} from '../../../../components';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {LLMProvider} from '../../../../types';

describe('SemanticValidatorNode Unit', function () {
  let node: SemanticValidatorNode;
  let llmStub: sinon.SinonStub;

  beforeEach(() => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;
    const schemaHelper = {
      asString: sinon.stub().returns(''),
    } as unknown as DbSchemaHelperService;

    node = new SemanticValidatorNode(llm, llm, {models: []}, schemaHelper);
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
      validationChecklist: '1. Query selects all users',
    };
    llmStub.resolves({
      content: '<valid/>',
    });

    const result = await node.execute(state, {});

    expect(result.semanticStatus).to.equal(EvaluationResult.Pass);
    sinon.assert.calledOnce(llmStub);
  });

  it('should return QueryError if the query is invalid', async () => {
    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM invalid_table',
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
      validationChecklist: '1. Query selects from users table',
    };
    llmStub.resolves({
      content:
        '<invalid>\n- Query selects from wrong table. Should select from users table instead.\n</invalid>',
    });

    const result = await node.execute(state, {});

    expect(result.semanticStatus).to.equal(EvaluationResult.QueryError);
    sinon.assert.calledOnce(llmStub);

    const prompt = llmStub.firstCall.args[0];
    // Verify the prompt contains the user question, checklist, SQL, and schema
    expect(prompt.value).to.containEql(state.sql);
    expect(prompt.value).to.containEql(state.prompt);
    expect(prompt.value).to.containEql('1. Query selects from users table');
    expect(prompt.value).to.containEql('<database-schema>');
    expect(prompt.value).to.containEql('<user-question>');
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
      validationChecklist: '1. Query selects all users',
    };
    llmStub.resolves({
      content: '<valid/>',
    });

    await node.execute(state, {});

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.containEql('the previous query was wrong');
  });
});

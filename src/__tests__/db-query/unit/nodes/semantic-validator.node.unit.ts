import {juggler} from '@loopback/repository';
import {expect, sinon} from '@loopback/testlab';
import {
  DbSchemaHelperService,
  EvaluationResult,
  SemanticValidatorNode,
  SqliteConnector,
} from '../../../../components';
import {LLMProvider} from '../../../../types';

describe('SemanticValidatorNode Unit', function () {
  let node: SemanticValidatorNode;
  let llmStub: sinon.SinonStub;
  let schemaHelper: DbSchemaHelperService;

  beforeEach(() => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;

    schemaHelper = new DbSchemaHelperService(
      new SqliteConnector(
        new juggler.DataSource({
          connector: 'sqlite3',
          file: ':memory:',
          name: 'db',
          debug: true,
        }),
      ),
    );

    // Mock the getTablesContext method
    sinon
      .stub(schemaHelper, 'getTablesContext')
      .returns(['employee salary must be converted to USD']);

    node = new SemanticValidatorNode(llm, schemaHelper, ['test context']);
  });

  afterEach(() => {
    sinon.restore();
  });
  it('should return the same query if it is valid', async () => {
    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM users',
      schema: {
        tables: {
          employees: {
            description: 'Employee data',
            context: ['employee salary must be converted to USD'],
            columns: {},
            primaryKey: [],
            hash: '',
          },
        },
        relations: [],
      },
      status: EvaluationResult.Pass,
      id: 'test-id',
      feedbacks: [],
      replyToUser: '',
      dataset: [],
      datasetId: 'test-dataset-id',
      done: false,
      sampleSqlPrompt: '',
      sampleSql: '',
      fromCache: false,
      resultArray: undefined,
    };
    llmStub.resolves({
      content: 'valid',
    });

    const result = await node.execute(state, {});

    expect(result.status).to.equal(EvaluationResult.Pass);
    sinon.assert.calledOnce(llmStub);
  });

  it('should throw an error if the query is invalid', async () => {
    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM invalid_table',
      schema: {
        tables: {
          employees: {
            description: 'Employee data',
            context: [],
            columns: {},
            primaryKey: [],
            hash: '',
          },
        },
        relations: [],
      },
      status: EvaluationResult.Pass,
      id: 'test-id',
      feedbacks: [],
      replyToUser: '',
      dataset: [],
      datasetId: 'test-dataset-id',
      done: false,
      sampleSqlPrompt: '',
      sampleSql: '',
      fromCache: false,
      resultArray: undefined,
    };
    llmStub.resolves({
      content: 'invalid: table `invalid_table` does not exist',
    });

    const result = await node.execute(state, {});

    expect(result.status).to.equal(EvaluationResult.QueryError);
    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];

    expect(prompt.value).to.eql(`
<instructions>
You are an AI assistant that judges whether the generated and syntactically verified SQL query will satisfy the user's query and the additional checks provided.
The query has already been validated for syntax and correctness, so you only need to check if it satisfies the user's query and all the additional checks provided.
Note that query has already been validated for syntax and correctness, so you only need to check if it satisfies the user's query and all the additional checks provided.
You must create a checklist and ensure that the query satisfies all the points in the checklist.
</instructions>

<latest-query>
${state.sql}
</latest-query>

<user-question>
${state.prompt}
</user-question>

<database-schema>
${schemaHelper.asString(state.schema)}
</database-schema>

<must-follow-rules>
It is really important that the query follows all the following context information -
test context
employee salary must be converted to USD
</must-follow-rules>



<output-instructions>
The last line of your response must be either 'valid' or 'invalid'.
In case of 'invalid', you must provide the reasons for invalidity after a colon and space.
The format in case of invalid query should be -

invalid: reason for invalidity

The format in case of valid query should just be the string 'valid' with no other explanation or string, the output should just be -

valid

</output-instructions>
`);
  });

  it('should include feedbacks and context in the prompt', async () => {
    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM users',
      schema: {
        tables: {
          employees: {
            description: 'Employee data',
            context: ['employee salary must be converted to USD'],
            columns: {},
            primaryKey: [],
            hash: '',
          },
        },
        relations: [],
      },
      status: EvaluationResult.Pass,
      id: 'test-id',
      feedbacks: ['the previous query was wrong'],
      replyToUser: '',
      dataset: [],
      datasetId: 'test-dataset-id',
      done: false,
      sampleSqlPrompt: '',
      sampleSql: '',
      fromCache: false,
      resultArray: undefined,
    };
    llmStub.resolves({
      content: 'valid',
    });

    await node.execute(state, {});

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.eql(`
<instructions>
You are an AI assistant that judges whether the generated and syntactically verified SQL query will satisfy the user's query and the additional checks provided.
The query has already been validated for syntax and correctness, so you only need to check if it satisfies the user's query and all the additional checks provided.
Note that query has already been validated for syntax and correctness, so you only need to check if it satisfies the user's query and all the additional checks provided.
You must create a checklist and ensure that the query satisfies all the points in the checklist.
</instructions>

<latest-query>
${state.sql}
</latest-query>

<user-question>
${state.prompt}
</user-question>

<database-schema>
${schemaHelper.asString(state.schema)}
</database-schema>

<must-follow-rules>
It is really important that the query follows all the following context information -
test context
employee salary must be converted to USD
</must-follow-rules>


<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.

But was rejected by validator with the following errors -
${state.feedbacks.join('\n')}

Keep these feedbacks in mind while validating the new query.
</feedback-instructions>

<output-instructions>
The last line of your response must be either 'valid' or 'invalid'.
In case of 'invalid', you must provide the reasons for invalidity after a colon and space.
The format in case of invalid query should be -

invalid: reason for invalidity

The format in case of valid query should just be the string 'valid' with no other explanation or string, the output should just be -

valid

</output-instructions>
`);
  });
});

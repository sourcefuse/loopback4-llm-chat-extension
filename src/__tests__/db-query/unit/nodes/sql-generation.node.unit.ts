import {juggler} from '@loopback/repository';
import {expect, sinon} from '@loopback/testlab';
import {
  DbSchemaHelperService,
  SqlGenerationNode,
  SqliteConnector,
} from '../../../../components';
import {LLMProvider, SupportedDBs} from '../../../../types';

describe('SqlGenerationNode Unit', function () {
  let node: SqlGenerationNode;
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

    node = new SqlGenerationNode(
      llm,
      {
        db: {
          dialect: SupportedDBs.SQLite,
        },
        models: [],
      },
      schemaHelper,
      ['test context'],
    );
  });

  it('should generate SQL query based on the provided prompt', async () => {
    llmStub.resolves({
      content: '<think>thinking about it</think>SELECT * FROM employees;',
    });

    const state = {
      prompt: 'Generate a SQL query to select all employees',
      schema: {
        tables: {
          employees: {
            columns: {
              id: {type: 'number', required: true, id: true},
              name: {type: 'string', required: true, id: false},
            },
            primaryKey: ['id'],
            description: 'Employee table',
            context: [],
            hash: 'hash1',
          },
        },
        relations: [],
      },
      feedbacks: [],
      sampleSql: undefined,
      sampleSqlPrompt: undefined,
      done: false,
      sql: undefined,
      status: undefined,
      id: '123',
      replyToUser: undefined,
      datasetId: undefined,
      fromCache: false,
      resultArray: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.eql(`
### Instructions:
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a ${SupportedDBs.SQLite} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.


### Input:
Generate an SQL query that answers the question -
'${state.prompt}'
This query will run on a database whose schema is represented in this string:
${schemaHelper.asString(state.schema)}

You must keep these additional details in mind while writing the query -
test context




### Output:
Return the SQL query as a string, without any additional text, quotations, code block, comments or any other non sql token.
The output should be a valid SQL query that can run on the database schema provided.`);
  });

  it('should generate SQL query based on the provided prompt with a single feedback from some validation stage', async () => {
    llmStub.resolves({
      content: '<think>thinking about it</think>SELECT * FROM employees;',
    });

    const state = {
      prompt: 'Generate a SQL query to select all employees',
      schema: {
        tables: {
          employees: {
            columns: {
              id: {type: 'number', required: true, id: true},
              name: {type: 'string', required: true, id: false},
            },
            primaryKey: ['id'],
            description: 'Employee table',
            context: [],
            hash: 'hash1',
          },
        },
        relations: [],
      },
      feedbacks: [`The last query was using wrong table`],
      sampleSql: 'test sql',
      sampleSqlPrompt: `test sql prompt`,
      done: false,
      sql: `select * from wrong_table;`,
      status: undefined,
      id: '123',
      replyToUser: undefined,
      datasetId: undefined,
      fromCache: false,
      resultArray: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.eql(`
### Instructions:
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a ${SupportedDBs.SQLite} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.


### Input:
Generate an SQL query that answers the question -
'${state.prompt}'
This query will run on a database whose schema is represented in this string:
${schemaHelper.asString(state.schema)}

You must keep these additional details in mind while writing the query -
test context




We also need to consider the users feedback on the last attempt at query generation.
Make sure you do not repeat the mistakes made in the last attempt.
In the last attempt, you generated this SQL query -
${state.sql}

This was the error in the latest query you generated - \n${state.feedbacks[0]}



Keep these feedbacks in mind while generating the new query or improving this one SQL query.

### Output:
Return the SQL query as a string, without any additional text, quotations, code block, comments or any other non sql token.
The output should be a valid SQL query that can run on the database schema provided.`);
  });

  it('should generate SQL query based on the provided prompt with a multiple feedbacks from from previous loops', async () => {
    llmStub.resolves({
      content: '<think>thinking about it</think>SELECT * FROM employees;',
    });

    const state = {
      prompt: 'Generate a SQL query to select all employees',
      schema: {
        tables: {
          employees: {
            columns: {
              id: {type: 'number', required: true, id: true},
              name: {type: 'string', required: true, id: false},
            },
            primaryKey: ['id'],
            description: 'Employee table',
            context: [],
            hash: 'hash1',
          },
        },
        relations: [],
      },
      feedbacks: [
        `The last query was using wrong table`,
        `The last query was not using the correct types`,
        `The last query was not using the correct columns`,
      ],
      sampleSql: 'test sql',
      sampleSqlPrompt: `test sql prompt`,
      done: false,
      sql: `select * from wrong_table;`,
      status: undefined,
      id: '123',
      replyToUser: undefined,
      datasetId: undefined,
      fromCache: false,
      resultArray: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.eql(`
### Instructions:
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a ${SupportedDBs.SQLite} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.


### Input:
Generate an SQL query that answers the question -
'${state.prompt}'
This query will run on a database whose schema is represented in this string:
${schemaHelper.asString(state.schema)}

You must keep these additional details in mind while writing the query -
test context




We also need to consider the users feedback on the last attempt at query generation.
Make sure you do not repeat the mistakes made in the last attempt.
In the last attempt, you generated this SQL query -
${state.sql}

This was the error in the latest query you generated - \n${state.feedbacks[2]}

You already faced following issues in the past -
${state.feedbacks[0]}
${state.feedbacks[1]}

Keep these feedbacks in mind while generating the new query or improving this one SQL query.

### Output:
Return the SQL query as a string, without any additional text, quotations, code block, comments or any other non sql token.
The output should be a valid SQL query that can run on the database schema provided.`);
  });
});

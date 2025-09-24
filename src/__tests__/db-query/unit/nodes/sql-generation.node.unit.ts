import {juggler} from '@loopback/repository';
import {expect, sinon} from '@loopback/testlab';
import {
  DbSchemaHelperService,
  SqlGenerationNode,
  SqliteConnector,
} from '../../../../components';
import {LLMProvider, SupportedDBs} from '../../../../types';
import {IAuthUserWithPermissions} from 'loopback4-authorization';

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
        {} as unknown as IAuthUserWithPermissions,
      ),
      {models: []},
    );

    // Mock the getTablesContext method
    sinon
      .stub(schemaHelper, 'getTablesContext')
      .returns(['Table employees contains employee information']);

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

  afterEach(() => {
    sinon.restore();
  });

  it('should generate SQL query based on the provided prompt', async () => {
    llmStub.resolves({
      content:
        '<think>thinking about it</think><sql>SELECT * FROM employees;</sql><description>Get all employees</description>',
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
      description: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.eql(`
<instructions>
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a ${SupportedDBs.SQLite} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.
- Do not make any assumptions about the user's intent beyond what is explicitly provided in the prompt.
- Ensure proper grouping with brackets for where clauses with multiple conditions using AND and OR.
- Follow each and every single rule in the "must-follow-rules" section carefully while writing the query. DO NOT SKIP ANY RULE.
</instructions>
<user-question>
${state.prompt}
</user-question>
<context>
<database-schema>
${schemaHelper.asString(state.schema)}
</database-schema>

<must-follow-rules>
You must keep these additional details in mind while writing the query -
- test context
- Table employees contains employee information
</must-follow-rules>




</context>
<output-instructions>
Return the output in the following format with exactly 2 parts within opening and closing tags - 
<sql>
Contains the required valid SQL satisfying all the constraints
It should have no other character or symbol or character that is not part of SQLs.
Every single line of SQL should have a comment above it explaining the purpose of that line
</sql>
<description>
A very detailed but non-technical description of the SQL describing every single condition and concept used in the SQL statement. DO NOT OMMIT ANY DETAIL.
It should just be a plain english text with no other special formatting or special character. 
It should NOT use any technical jargon or database specific terminology like tables or columns.
Try to keep it short and to the point while not omitting any detail.
Do not use any DB concepts like enum numbers, joins, CTEs, subqueries etc. in the description.
</description>
</output-instructions>`);
  });

  it('should generate SQL query based on the provided prompt with a single feedback from some validation stage', async () => {
    llmStub.resolves({
      content:
        '<think>thinking about it</think><sql>SELECT * FROM employees;</sql><description>Get all employees</description>',
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
      description: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.eql(`
<instructions>
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a ${SupportedDBs.SQLite} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.
- Do not make any assumptions about the user's intent beyond what is explicitly provided in the prompt.
- Ensure proper grouping with brackets for where clauses with multiple conditions using AND and OR.
- Follow each and every single rule in the "must-follow-rules" section carefully while writing the query. DO NOT SKIP ANY RULE.
</instructions>
<user-question>
${state.prompt}
</user-question>
<context>
<database-schema>
${schemaHelper.asString(state.schema)}
</database-schema>

<must-follow-rules>
You must keep these additional details in mind while writing the query -
- test context
- Table employees contains employee information
</must-follow-rules>




<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.
Make sure you fix the provided error without introducing any new or past errors.
In the last attempt, you generated this SQL query -
<last-generated-query>
${state.sql}
</last-generated-query>

<last-error>
This was the error in the latest query you generated - \n${state.feedbacks[0]}
</last-error>


</feedback-instructions>
</context>
<output-instructions>
Return the output in the following format with exactly 2 parts within opening and closing tags - 
<sql>
Contains the required valid SQL satisfying all the constraints
It should have no other character or symbol or character that is not part of SQLs.
Every single line of SQL should have a comment above it explaining the purpose of that line
</sql>
<description>
A very detailed but non-technical description of the SQL describing every single condition and concept used in the SQL statement. DO NOT OMMIT ANY DETAIL.
It should just be a plain english text with no other special formatting or special character. 
It should NOT use any technical jargon or database specific terminology like tables or columns.
Try to keep it short and to the point while not omitting any detail.
Do not use any DB concepts like enum numbers, joins, CTEs, subqueries etc. in the description.
</description>
</output-instructions>`);
  });

  it('should generate SQL query based on the provided prompt with a multiple feedbacks from from previous loops', async () => {
    llmStub.resolves({
      content:
        '<think>thinking about it</think><sql>SELECT * FROM employees;</sql><description>Get all employees</description>',
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
      description: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.eql(`
<instructions>
You are an expert AI assistant that generates SQL queries based on user questions and a given database schema.
You try to following the instructions carefully to generate the SQL query that answers the question.
Do not hallucinate details or make up information.
Your task is to convert a question into a SQL query, given a ${SupportedDBs.SQLite} database schema.
Adhere to these rules:
- **Deliberately go through the question and database schema word by word** to appropriately answer the question
- **DO NOT make any DML statements** (INSERT, UPDATE, DELETE, DROP etc.) to the database.
- Never query for all the columns from a specific table, only ask for the relevant columns for the given the question.
- You can only generate a single query, so if you need multiple results you can use JOINs, subqueries, CTEs or UNIONS.
- Do not make any assumptions about the user's intent beyond what is explicitly provided in the prompt.
- Ensure proper grouping with brackets for where clauses with multiple conditions using AND and OR.
- Follow each and every single rule in the "must-follow-rules" section carefully while writing the query. DO NOT SKIP ANY RULE.
</instructions>
<user-question>
${state.prompt}
</user-question>
<context>
<database-schema>
${schemaHelper.asString(state.schema)}
</database-schema>

<must-follow-rules>
You must keep these additional details in mind while writing the query -
- test context
- Table employees contains employee information
</must-follow-rules>




<feedback-instructions>
We also need to consider the users feedback on the last attempt at query generation.
Make sure you fix the provided error without introducing any new or past errors.
In the last attempt, you generated this SQL query -
<last-generated-query>
${state.sql}
</last-generated-query>

<last-error>
This was the error in the latest query you generated - \n${state.feedbacks[2]}
</last-error>

<historical-feedbacks>
You already faced following issues in the past -
${state.feedbacks[0]}
${state.feedbacks[1]}
</historical-feedbacks>
</feedback-instructions>
</context>
<output-instructions>
Return the output in the following format with exactly 2 parts within opening and closing tags - 
<sql>
Contains the required valid SQL satisfying all the constraints
It should have no other character or symbol or character that is not part of SQLs.
Every single line of SQL should have a comment above it explaining the purpose of that line
</sql>
<description>
A very detailed but non-technical description of the SQL describing every single condition and concept used in the SQL statement. DO NOT OMMIT ANY DETAIL.
It should just be a plain english text with no other special formatting or special character. 
It should NOT use any technical jargon or database specific terminology like tables or columns.
Try to keep it short and to the point while not omitting any detail.
Do not use any DB concepts like enum numbers, joins, CTEs, subqueries etc. in the description.
</description>
</output-instructions>`);
  });

  it('should generate SQL query with sample queries when no feedbacks but has sample SQL', async () => {
    llmStub.resolves({
      content:
        '<think>thinking about it</think><sql>SELECT * FROM employees;</sql><description>Get all employees</description>',
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
      sampleSql: 'SELECT name FROM employees WHERE id = 1',
      sampleSqlPrompt: 'Get employee name by id',
      done: false,
      sql: undefined,
      status: undefined,
      id: '123',
      replyToUser: undefined,
      datasetId: undefined,
      fromCache: true,
      resultArray: undefined,
      description: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.match(
      /Here is an example query for reference that is similar to the question asked and has been validated by the user/,
    );
    expect(prompt.value).to.match(/SELECT name FROM employees WHERE id = 1/);
    expect(prompt.value).to.match(
      /This was generated for the following question - \nGet employee name by id/,
    );
  });

  it('should generate SQL query with baseline sample queries when no feedbacks and not from cache', async () => {
    llmStub.resolves({
      content:
        '<think>thinking about it</think><sql>SELECT * FROM employees;</sql><description>Get all employees</description>',
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
      sampleSql: 'SELECT name FROM employees WHERE id = 1',
      sampleSqlPrompt: 'Get employee name by id',
      done: false,
      sql: undefined,
      status: undefined,
      id: '123',
      replyToUser: undefined,
      datasetId: undefined,
      fromCache: false,
      resultArray: undefined,
      description: undefined,
    };

    const result = await node.execute(state, {});

    expect(result.sql).to.equal('SELECT * FROM employees;');

    sinon.assert.calledOnce(llmStub);
    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.match(
      /Here is the last running SQL query that was generated by user that is supposed to be used as the base line for the next query generation\./,
    );
    expect(prompt.value).to.match(/SELECT name FROM employees WHERE id = 1/);
    expect(prompt.value).to.match(
      /This was generated for the following question - \nGet employee name by id/,
    );
  });
});

import {expect, sinon} from '@loopback/testlab';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {
  EvaluationResult,
  FixQueryNode,
  GenerationError,
} from '../../../../components';
import {DbSchemaHelperService} from '../../../../components/db-query/services';
import {DbQueryState} from '../../../../components/db-query/state';
import {RuntimeLLMProvider, SupportedDBs} from '../../../../types';

describe('FixQueryNode Unit', function () {
  let node: FixQueryNode;
  let llmStub: sinon.SinonStub;
  let schemaHelper: DbSchemaHelperService;

  beforeEach(() => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as RuntimeLLMProvider;
    schemaHelper = {
      asString: sinon.stub().returns('CREATE TABLE users (id INT, name TEXT);'),
      getTablesContext: sinon.stub().returns([]),
    } as unknown as DbSchemaHelperService;

    node = new FixQueryNode(
      llm,
      {
        db: {dialect: SupportedDBs.PostgreSQL},
        models: [],
      },
      schemaHelper,
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should fix a query and return Pass status with corrected SQL', async () => {
    llmStub.resolves({
      content: 'SELECT id, name FROM users WHERE id = 1;',
    });

    const state = {
      prompt: 'Get user by id 1',
      sql: 'SELECT id, nama FROM users WHERE id = 1;',
      schema: {
        tables: {
          users: {
            columns: {
              id: {type: 'number', required: true, id: true},
              name: {type: 'string', required: true, id: false},
            },
            primaryKey: ['id'],
            description: 'Users table',
            context: [],
            hash: 'hash1',
          },
        },
        relations: [],
      },
      feedbacks: [
        'Query Validation Failed by DB: query_error with error column "nama" does not exist',
      ],
      syntacticErrorTables: ['users'],
      semanticErrorTables: undefined,
      validationChecklist: undefined,
    };

    const result = await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    expect(result.status).to.equal(EvaluationResult.Pass);
    expect(result.sql).to.equal('SELECT id, name FROM users WHERE id = 1;');
    sinon.assert.calledOnce(llmStub);
  });

  it('should return Failed status when LLM returns empty response', async () => {
    llmStub.resolves({
      content: '',
    });

    const state = {
      prompt: 'Get user by id 1',
      sql: 'SELECT * FROM users',
      schema: {tables: {users: {}}, relations: []},
      feedbacks: ['Some error'],
      syntacticErrorTables: ['users'],
      semanticErrorTables: undefined,
      validationChecklist: undefined,
    };

    const result = await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    expect(result.status).to.equal(GenerationError.Failed);
    expect(result.replyToUser).to.containEql('Failed to fix SQL query');
  });

  it('should strip markdown code fences from the LLM response', async () => {
    llmStub.resolves({
      content: '```sql\nSELECT * FROM users WHERE id = 1;\n```',
    });

    const state = {
      prompt: 'Get user by id 1',
      sql: 'SELECT * FROM users WHERE id = ?',
      schema: {
        tables: {
          users: {
            columns: {id: {type: 'number'}},
            primaryKey: ['id'],
            description: '',
            context: [],
            hash: '',
          },
        },
        relations: [],
      },
      feedbacks: ['Some error'],
      syntacticErrorTables: ['users'],
      semanticErrorTables: undefined,
      validationChecklist: undefined,
    };

    const result = await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    expect(result.sql).to.equal('SELECT * FROM users WHERE id = 1;');
  });

  it('should trim schema to only error-related tables', async () => {
    llmStub.resolves({
      content: 'SELECT u.id, u.name FROM users u;',
    });

    const state = {
      prompt: 'Get users',
      sql: 'SELECT u.id, u.nama FROM users u JOIN orders o ON u.id = o.user_id;',
      schema: {
        tables: {
          users: {
            columns: {
              id: {type: 'number', required: true, id: true},
              name: {type: 'string', required: true, id: false},
            },
            primaryKey: ['id'],
            description: 'Users table',
            context: [],
            hash: 'hash1',
          },
          orders: {
            columns: {
              id: {type: 'number', required: true, id: true},
              // eslint-disable-next-line @typescript-eslint/naming-convention
              user_id: {type: 'number', required: true, id: false},
            },
            primaryKey: ['id'],
            description: 'Orders table',
            context: [],
            hash: 'hash2',
          },
        },
        relations: [
          {
            table: 'orders',
            column: 'user_id',
            referencedTable: 'users',
            referencedColumn: 'id',
          },
          {
            table: 'products',
            column: 'category_id',
            referencedTable: 'categories',
            referencedColumn: 'id',
          },
        ],
      },
      feedbacks: ['Column nama not found in users'],
      syntacticErrorTables: ['users'],
      semanticErrorTables: undefined,
      validationChecklist: undefined,
    };

    await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    // Verify schemaHelper.asString was called with trimmed schema containing only error tables
    const asStringStub = schemaHelper.asString as sinon.SinonStub;
    const trimmedSchema = asStringStub.firstCall.args[0];
    expect(Object.keys(trimmedSchema.tables)).to.deepEqual(['users']);
    expect(trimmedSchema.relations).to.have.length(1);
    expect(trimmedSchema.relations[0].table).to.equal('orders');
    expect(trimmedSchema.relations[0].referencedTable).to.equal('users');
  });

  it('should merge syntactic and semantic error tables', async () => {
    llmStub.resolves({
      content: 'SELECT * FROM users JOIN orders ON users.id = orders.user_id;',
    });

    const state = {
      prompt: 'Get users with orders',
      sql: 'SELECT * FROM users JOIN orders ON users.id = orders.uid;',
      schema: {
        tables: {
          users: {
            columns: {},
            primaryKey: [],
            description: '',
            context: [],
            hash: '',
          },
          orders: {
            columns: {},
            primaryKey: [],
            description: '',
            context: [],
            hash: '',
          },
          products: {
            columns: {},
            primaryKey: [],
            description: '',
            context: [],
            hash: '',
          },
        },
        relations: [],
      },
      feedbacks: ['Error in query'],
      syntacticErrorTables: ['users'],
      semanticErrorTables: ['orders'],
      validationChecklist: undefined,
    };

    await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    const asStringStub = schemaHelper.asString as sinon.SinonStub;
    const trimmedSchema = asStringStub.firstCall.args[0];
    expect(Object.keys(trimmedSchema.tables).sort()).to.deepEqual([
      'orders',
      'users',
    ]);
  });

  it('should include validation checklist in the prompt when available', async () => {
    llmStub.resolves({
      content: 'SELECT * FROM users;',
    });

    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM usr;',
      schema: {tables: {users: {}}, relations: []},
      feedbacks: ['Table usr not found'],
      syntacticErrorTables: ['users'],
      semanticErrorTables: undefined,
      validationChecklist:
        '1. Always use full table names\n2. Include id column',
    };

    await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.containEql('Always use full table names');
    expect(prompt.value).to.containEql('Include id column');
  });

  it('should include historical errors in the prompt when multiple feedbacks exist', async () => {
    llmStub.resolves({
      content: 'SELECT * FROM users WHERE id = 1;',
    });

    const state = {
      prompt: 'Get user by id',
      sql: 'SELECT * FROM users WHERE id == 1;',
      schema: {tables: {users: {}}, relations: []},
      feedbacks: [
        'First error: syntax issue',
        'Second error: wrong operator',
        'Third error: still wrong',
      ],
      syntacticErrorTables: ['users'],
      semanticErrorTables: undefined,
      validationChecklist: undefined,
    };

    await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    const prompt = llmStub.firstCall.args[0];
    // Last feedback is the current error
    expect(prompt.value).to.containEql('Third error: still wrong');
    // Historical errors should be included
    expect(prompt.value).to.containEql('First error: syntax issue');
    expect(prompt.value).to.containEql('Second error: wrong operator');
  });

  it('should handle empty error tables gracefully', async () => {
    llmStub.resolves({
      content: 'SELECT * FROM users;',
    });

    const state = {
      prompt: 'Get all users',
      sql: 'SELECT * FROM users',
      schema: {
        tables: {
          users: {
            columns: {},
            primaryKey: [],
            description: '',
            context: [],
            hash: '',
          },
        },
        relations: [],
      },
      feedbacks: ['Some validation error'],
      syntacticErrorTables: undefined,
      semanticErrorTables: undefined,
      validationChecklist: undefined,
    };

    await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    const asStringStub = schemaHelper.asString as sinon.SinonStub;
    const trimmedSchema = asStringStub.firstCall.args[0];
    expect(Object.keys(trimmedSchema.tables)).to.deepEqual([]);
  });

  it('should pass the current query and prompt to the LLM', async () => {
    llmStub.resolves({
      content: 'SELECT * FROM users;',
    });

    const state = {
      prompt: 'Get all active users',
      sql: 'SELECT * FROM usr WHERE active = true;',
      schema: {tables: {users: {}}, relations: []},
      feedbacks: ['Table usr does not exist'],
      syntacticErrorTables: ['users'],
      semanticErrorTables: undefined,
      validationChecklist: undefined,
    };

    await node.execute(
      state as unknown as DbQueryState,
      {} as LangGraphRunnableConfig,
    );

    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.containEql('Get all active users');
    expect(prompt.value).to.containEql(
      'SELECT * FROM usr WHERE active = true;',
    );
    expect(prompt.value).to.containEql('Table usr does not exist');
  });
});

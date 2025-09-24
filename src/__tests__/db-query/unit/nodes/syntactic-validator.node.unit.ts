import {juggler} from '@loopback/repository';
import {expect, sinon} from '@loopback/testlab';
import {
  DbQueryState,
  EvaluationResult,
  IDbConnector,
  SqliteConnector,
  SyntacticValidatorNode,
} from '../../../../components';
import {LLMProvider} from '../../../../types';
import {IAuthUserWithPermissions} from 'loopback4-authorization';

describe('SyntacticValidatorNode Unit', function () {
  let node: SyntacticValidatorNode;
  let llmStub: sinon.SinonStub;
  let connector: IDbConnector;

  beforeEach(async () => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;

    const ds = new juggler.DataSource({
      connector: 'sqlite3',
      file: ':memory:',
      name: 'db',
      debug: true,
    });
    await ds.execute(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          age INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    connector = new SqliteConnector(
      ds,
      {} as unknown as IAuthUserWithPermissions,
    );

    node = new SyntacticValidatorNode(llm, connector);
  });

  it('should return pass status in state if it is valid', async () => {
    const state = {
      sql: 'SELECT * FROM users',
      schema: {
        tables: {},
      },
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});
    expect(llmStub.calledOnce).to.be.false();
    expect(result).to.deepEqual({
      ...state,
      status: EvaluationResult.Pass,
    });
  });

  it('should return a feedback with table error if query has table related error', async () => {
    const state = {
      sql: 'SELECT * FROM users_wrong',
      schema: {
        tables: {},
      },
    } as unknown as DbQueryState;

    llmStub.resolves({content: EvaluationResult.TableError});

    const result = await node.execute(state, {});
    expect(result.status).to.equal(EvaluationResult.TableError);
    expect(result).to.deepEqual({
      ...state,
      status: EvaluationResult.TableError,
      feedbacks: [
        `Query Validation Failed by DB: ${EvaluationResult.TableError} with error SQLITE_ERROR: no such table: users_wrong`,
      ],
    });
  });

  it('should return a feedback with query error if query has non table related error', async () => {
    const state = {
      sql: 'SELECT * users',
      schema: {
        tables: {},
      },
    } as unknown as DbQueryState;

    llmStub.resolves({content: EvaluationResult.QueryError});

    const result = await node.execute(state, {});
    expect(result.status).to.equal(EvaluationResult.QueryError);
    expect(result).to.deepEqual({
      ...state,
      status: EvaluationResult.QueryError,
      feedbacks: [
        `Query Validation Failed by DB: ${EvaluationResult.QueryError} with error SQLITE_ERROR: near \"users\": syntax error`,
      ],
    });
  });
});

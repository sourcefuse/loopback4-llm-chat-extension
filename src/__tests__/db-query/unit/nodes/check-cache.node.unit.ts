import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {
  CacheResults,
  CheckCacheNode,
  DatasetActionType,
  DataSetHelper,
  DbQueryState,
  QueryCacheMetadata,
} from '../../../../components';
import {BaseRetriever} from '../../../../vector';
import {createMockLLM, MockLLM} from '../../../test-helper';

describe('CheckCacheNode Unit', function () {
  let node: CheckCacheNode;
  let cacheStub: sinon.SinonStub;
  let llm: MockLLM;
  let datasetHelperStub: StubbedInstanceWithSinonAccessor<DataSetHelper>;

  beforeEach(() => {
    cacheStub = sinon.stub();
    llm = createMockLLM();
    datasetHelperStub = createStubInstance(DataSetHelper);
    const cache = {
      invoke: cacheStub,
    } as unknown as BaseRetriever<QueryCacheMetadata>;

    node = new CheckCacheNode(cache, llm.model, datasetHelperStub);
    datasetHelperStub.stubs.checkPermissions.resolves([]);
  });

  it('should return state as it is if no relevant query found in cache', async () => {
    llm.setText(CacheResults.NotRelevant);
    cacheStub.resolves([]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
  });

  it('should return state with sampleSql if relevant query found in cache', async () => {
    llm.setText(CacheResults.Similar + ' 1');
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {query: `SELECT * FROM employees WHERE name = 'Akshat'`},
      },
    ]);
    const state = {
      prompt: 'What is the salary of Dhruv?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({
      sampleSql: "SELECT * FROM employees WHERE name = 'Akshat'",
      sampleSqlPrompt: 'What is the salary of Akshat?',
    });
  });

  it('should return state with datasetId and fromCache true if exact query found in cache with matching permissions, and if user has liked it in the past', async () => {
    llm.setText(CacheResults.AsIs + ' 1');
    datasetHelperStub.stubs.checkPermissions.resolves([]);
    datasetHelperStub.stubs.find.resolves([
      {
        id: '123',
        description: 'What is the salary of Akshat?',
        query: `SELECT * FROM employees WHERE name = 'Akshat'`,
        prompt: 'What is the salary of Akshat?',
        createdBy: 'test-user',
        votes: 0,
        tables: ['employees'],
        schemaHash: 'hash',
        tenantId: 'test-tenant',
        actions: undefined,
      },
    ]);
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {
          query: `SELECT * FROM employees WHERE name = 'Akshat'`,
          datasetId: '123',
        },
      },
    ]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({
      fromCache: true,
      datasetId: '123',
      replyToUser: `I found this dataset in the cache - What is the salary of Akshat?`,
    });
  });

  it('should return state with datasetId and fromCache true if exact query found in cache with matching permissions, and if user has not seen it in past', async () => {
    llm.setText(CacheResults.AsIs + ' 1');
    datasetHelperStub.stubs.checkPermissions.resolves([]);
    datasetHelperStub.stubs.find.resolves([
      {
        id: '123',
        description: 'What is the salary of Akshat?',
        query: `SELECT * FROM employees WHERE name = 'Akshat'`,
        prompt: 'What is the salary of Akshat?',
        createdBy: 'test-user',
        votes: 0,
        tables: ['employees'],
        schemaHash: 'hash',
        tenantId: 'test-tenant',
        actions: [
          {
            action: DatasetActionType.Liked,
            datasetId: '123',
            userId: 'test-user',
          },
        ],
      },
    ]);
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {
          query: `SELECT * FROM employees WHERE name = 'Akshat'`,
          datasetId: '123',
        },
      },
    ]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({
      fromCache: true,
      datasetId: '123',
      replyToUser: `I found this dataset in the cache - What is the salary of Akshat?`,
    });
  });

  it('should not return state with datasetId and fromCache true even if exact query found in cache with matching permissions, if it was disliked by the user', async () => {
    llm.setText(CacheResults.AsIs + ' 1');
    datasetHelperStub.stubs.checkPermissions.resolves([]);
    datasetHelperStub.stubs.find.resolves([
      {
        id: '123',
        description: 'What is the salary of Akshat?',
        query: `SELECT * FROM employees WHERE name = 'Akshat'`,
        prompt: 'What is the salary of Akshat?',
        createdBy: 'test-user',
        votes: 0,
        tables: ['employees'],
        schemaHash: 'hash',
        tenantId: 'test-tenant',
        actions: [
          {
            action: DatasetActionType.Disliked,
            datasetId: '123',
            userId: 'test-user',
          },
        ],
      },
    ]);
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {
          query: `SELECT * FROM employees WHERE name = 'Akshat'`,
          datasetId: '123',
        },
      },
    ]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
  });

  it('should return existing state if exact query found in cache but with missing permissions', async () => {
    llm.setText(`${CacheResults.AsIs} 1`);
    datasetHelperStub.stubs.checkPermissions.resolves(['some permission']);
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {
          query: `SELECT * FROM employees WHERE name = 'Akshat'`,
          datasetId: '123',
        },
      },
    ]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
  });

  it('should return state as is if sampleSql already exists', async () => {
    const state = {
      prompt: 'What is the salary of Akshat?',
      sampleSql: 'SELECT salary FROM employees WHERE name = "existing"',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(cacheStub);
    expect(llm.calls).to.equal(0);
  });

  it('should return state as is if LLM returns invalid index', async () => {
    llm.setText(`${CacheResults.AsIs} 5`); // Index out of bounds
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {
          query: `SELECT * FROM employees WHERE name = 'Akshat'`,
          datasetId: '123',
        },
      },
    ]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
  });

  it('should return state as is if LLM returns non-numeric index', async () => {
    llm.setText(`${CacheResults.AsIs} abc`);
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {
          query: `SELECT * FROM employees WHERE name = 'Akshat'`,
          datasetId: '123',
        },
      },
    ]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
  });

  it('should return state as is if LLM returns not-relevant', async () => {
    llm.setText(`${CacheResults.NotRelevant} 1`);
    cacheStub.resolves([
      {
        pageContent: 'What is the salary of Akshat?',
        metadata: {
          query: `SELECT * FROM employees WHERE name = 'Akshat'`,
          datasetId: '123',
        },
      },
    ]);
    const state = {
      prompt: 'What is the salary of Dhruv?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
  });
});

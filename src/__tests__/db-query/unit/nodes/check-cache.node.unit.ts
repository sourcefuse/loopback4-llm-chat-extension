import {BaseRetriever} from '@langchain/core/retrievers';
import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {
  CheckCacheNode,
  DataSetHelper,
  DbQueryState,
  QueryCacheMetadata,
} from '../../../../components';
import {LLMProvider} from '../../../../types';

describe('CheckCacheNode Unit', function () {
  let node: CheckCacheNode;
  let cacheStub: sinon.SinonStub;
  let llmStub: sinon.SinonStub;
  let datasetHelperStub: StubbedInstanceWithSinonAccessor<DataSetHelper>;

  beforeEach(() => {
    cacheStub = sinon.stub();
    llmStub = sinon.stub();
    datasetHelperStub = createStubInstance(DataSetHelper);
    const cache = {
      invoke: cacheStub,
    } as unknown as BaseRetriever<QueryCacheMetadata>;
    const llm = llmStub as unknown as LLMProvider;

    node = new CheckCacheNode(cache, llm, datasetHelperStub);
    datasetHelperStub.stubs.checkPermissions.resolves([]);
  });

  it('should return state as it is if no relevant query found in cache', async () => {
    llmStub.resolves({
      content: {
        toString: () => 'no-relevant-queries',
      },
    });
    cacheStub.resolves([]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual(state);
  });

  it('should return state with sampleSql if relevant query found in cache', async () => {
    llmStub.resolves({
      content: {
        toString: () => 'similar 1',
      },
    });
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
      ...state,
      sampleSql: "SELECT * FROM employees WHERE name = 'Akshat'",
      sampleSqlPrompt: 'What is the salary of Akshat?',
    });
  });

  it('should return state with datasetId and fromCache true if exact query found in cache with matching permissions', async () => {
    llmStub.resolves({
      content: {
        toString: () => 'as-is 1',
      },
    });
    datasetHelperStub.stubs.checkPermissions.resolves([]);
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
      ...state,
      fromCache: true,
      datasetId: '123',
      replyToUser: `I found this dataset in the cache - What is the salary of Akshat?`,
    });
  });

  it('should return existing state if exact query found in cache but with missing permissions', async () => {
    llmStub.resolves({
      content: {
        toString: () => 'as-is 1',
      },
    });
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

    expect(result).to.deepEqual({
      ...state,
    });
  });

  it('should return state as is if sampleSql already exists', async () => {
    const state = {
      prompt: 'What is the salary of Akshat?',
      sampleSql: 'SELECT salary FROM employees WHERE name = "existing"',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual(state);
    sinon.assert.notCalled(cacheStub);
    sinon.assert.notCalled(llmStub);
  });

  it('should return state as is if LLM returns invalid index', async () => {
    llmStub.resolves({
      content: {
        toString: () => 'as-is 5',
      },
    }); // Index out of bounds
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

    expect(result).to.deepEqual(state);
  });

  it('should return state as is if LLM returns non-numeric index', async () => {
    llmStub.resolves({
      content: {
        toString: () => 'as-is abc',
      },
    });
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

    expect(result).to.deepEqual(state);
  });

  it('should return state as is if LLM returns not-relevant', async () => {
    llmStub.resolves({
      content: {
        toString: () => 'not-relevant 1',
      },
    });
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

    expect(result).to.deepEqual(state);
  });
});

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
    llmStub.resolves({content: 'no-relevant-queries'});
    cacheStub.resolves([]);
    const state = {
      prompt: 'What is the salary of Akshat?',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result).to.deepEqual(state);
  });

  it('should return state with sampleSql if relevant query found in cache', async () => {
    llmStub.resolves({content: 'similar 0'});
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
    llmStub.resolves({content: 'as-is 0'});
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
    llmStub.resolves({content: 'as-is 0'});
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
});

import {expect, sinon} from '@loopback/testlab';
import {DataSetHelper} from '../../../../components/db-query/services';
import {DatasetActionType} from '../../../../components/db-query/constant';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  CacheResults,
  QueryCacheMetadata,
} from '../../../../components/db-query/types';
import {IVectorStoreDocument, LLMProvider} from '../../../../types';
import {DatasetSearchService} from '../../../../mastra/db-query/services/dataset-search.service';
import {checkCacheStep} from '../../../../mastra/db-query/workflow/steps/check-cache.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

describe('checkCacheStep (Mastra)', function () {
  let datasetSearchStub: {search: sinon.SinonStub};
  let dataSetHelperStub: {
    checkPermissions: sinon.SinonStub;
    find: sinon.SinonStub;
  };
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  const baseState = {
    prompt: 'What is the salary of John?',
    schema: {tables: {}, relations: []},
  } as unknown as DbQueryState;

  beforeEach(() => {
    datasetSearchStub = {search: sinon.stub()};
    dataSetHelperStub = {checkPermissions: sinon.stub(), find: sinon.stub()};
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  it('returns {} when sampleSql already set (fast exit)', async () => {
    const state = {
      ...baseState,
      sampleSql: 'SELECT 1',
    } as unknown as DbQueryState;

    const result = await checkCacheStep(state, context, {
      datasetSearch: datasetSearchStub as unknown as DatasetSearchService,
      llm: createFakeLanguageModel(
        CacheResults.NotRelevant,
      ) as unknown as LLMProvider,
      dataSetHelper: dataSetHelperStub as unknown as DataSetHelper,
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(datasetSearchStub.search);
  });

  it('returns {} when no documents found in cache', async () => {
    datasetSearchStub.search.resolves([]);

    const result = await checkCacheStep(baseState, context, {
      datasetSearch: datasetSearchStub as unknown as DatasetSearchService,
      llm: createFakeLanguageModel(
        CacheResults.NotRelevant,
      ) as unknown as LLMProvider,
      dataSetHelper: dataSetHelperStub as unknown as DataSetHelper,
    });

    expect(result).to.deepEqual({});
  });

  it('returns {} when LLM classifies as NotRelevant and calls onUsage', async () => {
    datasetSearchStub.search.resolves([
      {
        pageContent: 'Some past prompt',
        metadata: {description: 'some description'},
      } as IVectorStoreDocument<QueryCacheMetadata>,
    ]);

    const result = await checkCacheStep(baseState, context, {
      datasetSearch: datasetSearchStub as unknown as DatasetSearchService,
      llm: createFakeLanguageModel(
        CacheResults.NotRelevant,
        5,
        2,
      ) as unknown as LLMProvider,
      dataSetHelper: dataSetHelperStub as unknown as DataSetHelper,
    });

    expect(result).to.deepEqual({});
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
  });

  it('returns sampleSql when LLM classifies as Similar', async () => {
    const sql = "SELECT salary FROM employees WHERE name = 'John'";
    datasetSearchStub.search.resolves([
      {
        pageContent: 'What is the salary of John?',
        metadata: {description: 'Returns salary', query: sql, datasetId: '123'},
      } as unknown as IVectorStoreDocument<QueryCacheMetadata>,
    ]);

    const result = await checkCacheStep(baseState, context, {
      datasetSearch: datasetSearchStub as unknown as DatasetSearchService,
      llm: createFakeLanguageModel(
        `${CacheResults.Similar} 1`,
      ) as unknown as LLMProvider,
      dataSetHelper: dataSetHelperStub as unknown as DataSetHelper,
    });

    expect(result.sampleSql).to.equal(sql);
    sinon.assert.calledOnce(onUsageSpy);
  });

  it('returns fromCache=true when LLM classifies as AsIs and permissions pass', async () => {
    const sql = "SELECT salary FROM employees WHERE name = 'John'";
    datasetSearchStub.search.resolves([
      {
        pageContent: 'What is the salary of John?',
        metadata: {description: 'Returns salary', query: sql, datasetId: '42'},
      } as unknown as IVectorStoreDocument<QueryCacheMetadata>,
    ]);
    dataSetHelperStub.checkPermissions.resolves([]);
    dataSetHelperStub.find.resolves([
      {
        id: '42',
        query: sql,
        actions: [{type: DatasetActionType.Liked}],
      },
    ]);

    const result = await checkCacheStep(baseState, context, {
      datasetSearch: datasetSearchStub as unknown as DatasetSearchService,
      llm: createFakeLanguageModel(
        `${CacheResults.AsIs} 1`,
      ) as unknown as LLMProvider,
      dataSetHelper: dataSetHelperStub as unknown as DataSetHelper,
    });

    expect(result.fromCache).to.be.true();
    expect(result.datasetId).to.equal('42');
    sinon.assert.calledOnce(onUsageSpy);
  });
});

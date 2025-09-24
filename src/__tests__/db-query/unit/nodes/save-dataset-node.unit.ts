import {HttpErrors} from '@loopback/rest';
import {expect, sinon} from '@loopback/testlab';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {
  DbQueryState,
  IDataSetStore,
  SaveDataSetNode,
} from '../../../../components';
import {DataSet} from '../../../../components/db-query/models';
import {LLMProvider} from '../../../../types';
import {buildDatasetStoreStub} from '../../../test-helper';

describe('SaveDataSetNode Unit', function () {
  let node: SaveDataSetNode;
  let llmStub: sinon.SinonStub;
  let store: sinon.SinonStubbedInstance<IDataSetStore>;

  beforeEach(() => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;
    store = buildDatasetStoreStub();
    node = new SaveDataSetNode(llm, store, {models: []}, {
      tenantId: 'test-tenant',
      userTenantId: 'test-tenant',
      permissions: ['1'],
    } as IAuthUserWithPermissions);
  });

  it('should return state with dataset id', async () => {
    llmStub.resolves({
      content: 'dataset desc',
    });
    store.create.resolves(
      new DataSet({
        id: '123',
      }),
    );
    const result = await node.execute(
      {
        prompt: 'Save this dataset',
        schema: {
          tables: {},
          relations: [],
        },
        sql: 'SELECT * FROM test_table;',
        description: 'dataset desc',
      } as unknown as DbQueryState,
      {},
    );
    expect(result).to.have.property('datasetId');
    expect(result.datasetId).to.equal('123');
    expect(result.done).to.be.true();
    expect(result.replyToUser).to.equal(`dataset desc`);
  });

  it('should return state with dataset id and result array if readAccessForAI is true', async () => {
    node = new SaveDataSetNode(
      llmStub as unknown as LLMProvider,
      store,
      {models: [], readAccessForAI: true, maxRowsForAI: 50},
      {
        tenantId: 'test-tenant',
        userTenantId: 'test-tenant',
        permissions: ['1'],
      } as IAuthUserWithPermissions,
    );
    llmStub.resolves({
      content: 'dataset desc',
    });
    store.create.resolves(
      new DataSet({
        id: '123',
      }),
    );
    const expectedResult = [{id: 1, name: 'test'}];
    store.getData.resolves(expectedResult);
    const result = await node.execute(
      {
        prompt: 'Save this dataset',
        schema: {
          tables: {},
          relations: [],
        },
        sql: 'SELECT * FROM test_table;',
        description: 'dataset desc',
      } as unknown as DbQueryState,
      {},
    );
    expect(result).to.have.property('datasetId');
    expect(result.datasetId).to.equal('123');
    expect(result.done).to.be.true();
    expect(result.replyToUser).to.equal(`dataset desc`);
    expect(result.resultArray).to.deepEqual(expectedResult);
  });

  it('should throw error if user does not have tenantId', async () => {
    const llm = llmStub as unknown as LLMProvider;
    node = new SaveDataSetNode(llm, store, {models: []}, {
      userTenantId: 'test-tenant',
      permissions: ['1'],
    } as IAuthUserWithPermissions);
    await expect(
      node.execute(
        {
          prompt: 'Save this dataset',
          schema: {
            tables: {},
            relations: [],
          },
          sql: 'SELECT * FROM test_table;',
        } as unknown as DbQueryState,
        {},
      ),
    ).to.be.rejectedWith(
      new HttpErrors.BadRequest(`User does not have a tenantId`),
    );
  });

  it('should throw error if sql is not present in state', async () => {
    const llm = llmStub as unknown as LLMProvider;
    node = new SaveDataSetNode(llm, store, {models: []}, {
      tenantId: 'test-tenant',
      userTenantId: 'test-tenant',
      permissions: ['1'],
    } as IAuthUserWithPermissions);
    await expect(
      node.execute(
        {
          prompt: 'Save this dataset',
          schema: {
            tables: {},
            relations: [],
          },
        } as unknown as DbQueryState,
        {},
      ),
    ).to.be.rejectedWith(HttpErrors.InternalServerError());
  });
});

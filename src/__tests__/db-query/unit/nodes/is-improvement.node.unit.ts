import {expect, sinon} from '@loopback/testlab';
import {
  DbQueryState,
  IDataSetStore,
  IsImprovementNode,
} from '../../../../components';
import {buildDatasetStoreStub} from '../../../test-helper';

describe('IsImprovementNode Unit', function () {
  let node: IsImprovementNode;
  let store: sinon.SinonStubbedInstance<IDataSetStore>;

  beforeEach(() => {
    store = buildDatasetStoreStub();
    node = new IsImprovementNode(store);
  });

  it('should return state as it is if datasetId is not set', async () => {
    const state = {
      datasetId: undefined,
      prompt: 'Test prompt',
    } as unknown as DbQueryState;
    const result = await node.execute(state, {});
    expect(result).to.deepEqual(state);
  });

  it('should return state with sampleSql and sampleSqlPrompt if datasetId is set', async () => {
    const dataset = {
      id: 'test-dataset-id',
      query: 'SELECT * FROM employees',
      prompt: 'Test dataset prompt',
      tenantId: 'default',
      description: 'This is a test dataset',
      tables: ['employees'],
      schemaHash: 'test-schema-hash',
      votes: 0,
    };
    store.findById.resolves(dataset);

    const state = {
      datasetId: 'test-dataset-id',
      prompt: 'Test prompt',
    } as unknown as DbQueryState;
    const result = await node.execute(state, {});

    expect(result).to.deepEqual({
      ...state,
      sampleSql: dataset.query,
      sampleSqlPrompt: dataset.prompt,
      prompt: `${dataset.prompt}\n also consider following feedback given by user -\n ${state.prompt}\n`,
    });
  });
});

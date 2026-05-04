import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {IDataSetStore} from '../../../../components/db-query/types';
import {isImprovementStep} from '../../../../mastra/db-query/workflow/steps/is-improvement.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';

describe('isImprovementStep (Mastra)', function () {
  const context = {} as MastraDbQueryContext;

  it('returns empty when no datasetId in state', async () => {
    const state = {prompt: 'Show employees'} as unknown as DbQueryState;
    const store = {findById: sinon.stub()} as unknown as IDataSetStore;

    const result = await isImprovementStep(state, context, {store});

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(store.findById as sinon.SinonStub);
  });

  it('loads dataset and enriches state when datasetId is set', async () => {
    const state = {
      datasetId: 'ds-1',
      prompt: 'also add department filter',
      schema: {tables: {}, relations: []},
    } as unknown as DbQueryState;

    const store = {
      findById: sinon.stub().resolves({
        query: 'SELECT * FROM employees',
        prompt: 'Show all employees',
      }),
    } as unknown as IDataSetStore;

    const result = await isImprovementStep(state, context, {store});

    expect(result.sampleSql).to.equal('SELECT * FROM employees');
    expect(result.sampleSqlPrompt).to.equal('Show all employees');
    expect(result.prompt).to.match(/Show all employees/);
    expect(result.prompt).to.match(/also add department filter/);
    sinon.assert.calledOnceWithExactly(
      store.findById as sinon.SinonStub,
      'ds-1',
    );
  });
});

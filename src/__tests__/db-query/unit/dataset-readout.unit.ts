import {expect, sinon} from '@loopback/testlab';
import {buildDatasetReadout} from '../../../components/db-query/utils';
import type {IDataSetStore} from '../../../components/db-query/types';
import type {DbQueryConfig} from '../../../components/db-query/types';

/**
 * buildDatasetReadout is the AI-facing summary returned after a dataset is
 * generated/updated. It must NOT include actual row data unless the consumer
 * explicitly opts in via `config.readAccessForAI` (v2 SaveDataSetNode contract
 * + project rule "the AI never sees data by default"). When enabled, rows are
 * fetched with the `maxRowsForAI` cap. Failures are advisory (never throw).
 */
describe('buildDatasetReadout (AI data-access gate)', () => {
  const baseRe = /dataset id ds-1/i;

  it('returns only the completion ack when readAccessForAI is off', async () => {
    const getData = sinon.stub().resolves([{x: 1}]);
    const out = await buildDatasetReadout({
      datasetId: 'ds-1',
      verb: 'generated',
      store: {getData} as unknown as IDataSetStore,
      config: {readAccessForAI: false} as DbQueryConfig,
    });
    expect(out).to.match(baseRe);
    expect(out).to.not.match(/results from the dataset/);
    sinon.assert.notCalled(getData);
  });

  it('does not read rows when no config is supplied', async () => {
    const getData = sinon.stub().resolves([{x: 1}]);
    const out = await buildDatasetReadout({
      datasetId: 'ds-1',
      verb: 'generated',
      store: {getData} as unknown as IDataSetStore,
    });
    expect(out).to.not.match(/results from the dataset/);
    sinon.assert.notCalled(getData);
  });

  it('appends rows (capped by maxRowsForAI) when readAccessForAI is on', async () => {
    const rows = [{name: 'Alice'}];
    const getData = sinon.stub().resolves(rows);
    const out = await buildDatasetReadout({
      datasetId: 'ds-1',
      verb: 'generated',
      store: {getData} as unknown as IDataSetStore,
      config: {readAccessForAI: true, maxRowsForAI: 5} as DbQueryConfig,
    });
    expect(out).to.match(/results from the dataset/);
    expect(out).to.match(/Alice/);
    sinon.assert.calledWith(getData, 'ds-1', 5);
  });

  it('falls back to the ack (no throw) when the row read fails', async () => {
    const getData = sinon.stub().rejects(new Error('db down'));
    const out = await buildDatasetReadout({
      datasetId: 'ds-1',
      verb: 'updated',
      store: {getData} as unknown as IDataSetStore,
      config: {readAccessForAI: true} as DbQueryConfig,
    });
    expect(out).to.match(baseRe);
    expect(out).to.not.match(/results from the dataset/);
  });

  it('returns a could-not-generate message for an empty datasetId', async () => {
    const out = await buildDatasetReadout({datasetId: '', verb: 'generated'});
    expect(out).to.match(/could not generate/i);
  });
});

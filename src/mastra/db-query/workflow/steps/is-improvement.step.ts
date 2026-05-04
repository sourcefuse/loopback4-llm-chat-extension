import {DbQueryState} from '../../../../components/db-query/state';
import {IDataSetStore} from '../../../../components/db-query/types';
import {MastraDbQueryContext} from '../../types/db-query.types';

const debug = require('debug')('ai-integration:mastra:db-query:is-improvement');

export type IsImprovementStepDeps = {
  store: IDataSetStore;
};

/**
 * Detects whether the incoming request is an improvement on an existing
 * dataset query. If `state.datasetId` is set, loads the original query from
 * the dataset store and enriches the state so that subsequent steps treat
 * this run as a modification (not a fresh generation).
 *
 * No LLM call is made — this is a pure data-retrieval step.
 */
export async function isImprovementStep(
  state: DbQueryState,
  _context: MastraDbQueryContext,
  deps: IsImprovementStepDeps,
): Promise<Partial<DbQueryState>> {
  debug('step start', {datasetId: state.datasetId});

  if (!state.datasetId) {
    debug('no datasetId — treating as fresh generation');
    return {};
  }

  debug('loading existing dataset %s for improvement', state.datasetId);
  const dataset = await deps.store.findById(state.datasetId);

  const result = {
    sampleSql: dataset.query,
    sampleSqlPrompt: dataset.prompt,
    prompt: `${dataset.prompt}\n also consider following feedback given by user -\n ${state.prompt}\n`,
  };

  debug('step result', result);
  return result;
}

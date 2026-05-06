import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {DbQueryState} from '../../../../components/db-query/state';
import {IDataSetStore} from '../../../../components/db-query/types';
import {MastraDbQueryContext} from '../../types/db-query.types';

const debug = require('debug')('ai-integration:mastra:db-query:is-improvement');

export type IsImprovementStepDeps = {
  store: IDataSetStore;
};

/**
 * Plain async function containing the business logic — callable without
 * the Mastra workflow runtime. Used by the workflow DSL directly.
 */
export async function runIsImprovement(
  state: DbQueryState,
  context: MastraDbQueryContext,
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

/**
 * Detects whether the incoming request is an improvement on an existing
 * dataset query. If `state.datasetId` is set, loads the original query from
 * the dataset store and enriches the state so that subsequent steps treat
 * this run as a modification (not a fresh generation).
 *
 * No LLM call is made — this is a pure data-retrieval step.
 */
export const isImprovementStep = createStep({
  id: 'db-query-is-improvement',
  inputSchema: z.any(),
  outputSchema: z.any(),
  execute: async ({
    inputData,
  }: {
    inputData: {
      state: DbQueryState;
      context: MastraDbQueryContext;
      deps: IsImprovementStepDeps;
    };
  }): Promise<Partial<DbQueryState>> => {
    const {state, context, deps} = inputData;
    return runIsImprovement(state, context, deps);
  },
});

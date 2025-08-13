import {AnyObject} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {randomUUID} from 'crypto';
import {DbQueryGraph} from '../db-query.graph';
import {DatabaseSchema} from '../types';
import {DbQueryGraphTestCase} from './types';

export function dbQueryToolTests(cases: DbQueryGraphTestCase[]) {
  return cases.map(testCase => ({
    desc: testCase.prompt,
    fn: async (
      schema: DatabaseSchema,
      graphBuilder: DbQueryGraph,
      datasetExecuter: (id: string) => Promise<AnyObject[]>,
    ) => {
      const graph = await graphBuilder.build();
      const id = randomUUID();
      const state = await graph.invoke({
        prompt: testCase.prompt,
        id,
        schema,
        sql: undefined,
        status: undefined,
        feedbacks: undefined,
        replyToUser: undefined,
        datasetId: undefined,
        sampleSql: undefined,
        sampleSqlPrompt: undefined,
        fromCache: undefined,
        done: false,
      });
      if (!state.datasetId) {
        throw new Error('Dataset ID is not defined in the state');
      }
      const results = await datasetExecuter(state.datasetId);
      expect(results).deepEqual(testCase.result);
    },
  }));
}

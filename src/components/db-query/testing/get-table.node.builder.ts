import {RunnableConfig} from '@langchain/core/runnables';
import {AnyObject} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {GetTablesNode} from '../nodes';
import {DatabaseSchema} from '../types';
import {GetTableNodeTestCase} from './types';

export function getTableNodeTests(cases: GetTableNodeTestCase[]) {
  return cases.map(testCase => ({
    desc: testCase.query,
    fn: async (schema: DatabaseSchema, node: GetTablesNode) => {
      const result = await node.execute(
        {
          prompt: testCase.query,
          id: 'test-query',
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
        },
        {
          writer: (event: AnyObject[string]) => {},
        } as unknown as RunnableConfig,
      );
      testCase.expectedTables.forEach(table => {
        expect(result.schema.tables).to.have.property(table);
      });
    },
  }));
}

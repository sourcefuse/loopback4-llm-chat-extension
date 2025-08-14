import {Context} from '@loopback/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from 'loopback4-authorization';
import {
  DatabaseSchema,
  DbQueryAIExtensionBindings,
  getTableNodeTests,
  GetTablesNode,
  SchemaStore,
} from '../../../../components';
import {TestApp} from '../../../fixtures/test-app';
import {setupApplication} from '../../../test-helper';

describe('GetTablesNode Acceptance', function () {
  let app: TestApp;
  let node: GetTablesNode;
  let schema: DatabaseSchema;

  before('checkIfCanRun', function () {
    if (process.env.RUN_WITH_LLM !== 'true') {
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      this.skip();
    }
  });

  before('setupApplication', async () => {
    ({app} = await setupApplication({}));
    app.bind(DbQueryAIExtensionBindings.GlobalContext).to([]);
    const schemaService = await app.get<SchemaStore>(`services.SchemaStore`);
    schema = schemaService.get();
  });

  after(async () => {
    if (app) {
      await app.stop();
    }
  });

  beforeEach(async () => {
    const ctx = new Context(app, 'newCtx');
    ctx.bind(AuthenticationBindings.CURRENT_USER).to({
      userTenantId: 'test-tenant',
    } as unknown as IAuthUserWithPermissions);
    node = await ctx.get<GetTablesNode>(`services.GetTablesNode`);
  });

  const cases = getTableNodeTests([
    {
      query: 'Find all the resources that joined in the last month',
      expectedTables: ['employees'],
    },
    {
      query: 'Find all the resources that have salary greater than 1000 USD',
      expectedTables: ['employees', 'exchange_rates'],
    },
    {
      query: 'Show all the currencies that do not have any exchange rates',
      expectedTables: ['currencies'],
    },
    {
      query:
        'Show the latest exchange rate for each currency with currency name',
      expectedTables: ['currencies', 'exchange_rates'],
    },
  ]);

  for (const test of cases) {
    it(`should return tables for - ${test.desc}`, async () => {
      await test.fn(schema, node);
    });
  }
});

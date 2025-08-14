import {Context} from '@loopback/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from 'loopback4-authorization';
import {
  DatabaseSchema,
  DataSetHelper,
  DbQueryAIExtensionBindings,
  DbQueryGraph,
  dbQueryToolTests,
  SchemaStore,
} from '../../../components';
import {TestApp} from '../../fixtures/test-app';
import {
  seedCurrencies,
  seedEmployees,
  seedExchangeRates,
  setupApplication,
} from '../../test-helper';

describe(`DB Query Graph Acceptance`, () => {
  let app: TestApp;
  let schema: DatabaseSchema;
  let graphBuilder: DbQueryGraph;
  let datasetHelper: DataSetHelper;

  before('checkIfCanRun', function () {
    if (process.env.RUN_WITH_LLM !== 'true') {
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      this.skip();
    }
  });

  before('setupApplication', async () => {
    ({app} = await setupApplication({}));
    await seedEmployees(app);
    await seedCurrencies(app);
    await seedExchangeRates(app);
    app
      .bind(DbQueryAIExtensionBindings.GlobalContext)
      .to([
        `Every value with currency_id should be converted to USD before returning to the user.`,
      ]);
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
      tenantId: 'test-tenant',
      permissions: ['1', '2', '3'],
    } as unknown as IAuthUserWithPermissions);
    graphBuilder = await ctx.get<DbQueryGraph>(`services.DbQueryGraph`);
    datasetHelper = await ctx.get<DataSetHelper>(`services.DataSetHelper`);
  });

  const cases = dbQueryToolTests([
    {
      prompt:
        'Show the salary of the employee Charlie White in USD, the result should just have one column named "salary" with 2 decimal places',
      result: [
        {
          salary: 9952.61,
        },
      ],
    },
    {
      prompt:
        'Show all the employees who have salary greater than 8000 USD, the result should have just 1 column `name`, results ordered by name in ascending order',
      result: [
        {
          name: 'Charlie White',
        },
        {
          name: 'Nameless Gonbei',
        },
      ],
    },
  ]);

  for (const testCase of cases) {
    it(`should execute the graph for ${testCase.desc}`, async () => {
      await testCase.fn(schema, graphBuilder, async id => {
        return datasetHelper.getDataFromDataset(id);
      });
    });
  }
});

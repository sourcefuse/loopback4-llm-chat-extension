import {BindingScope} from '@loopback/core';
import {Client, expect} from '@loopback/testlab';
import {DbQueryAIExtensionBindings, IDataSetStore} from '../../components';
import {LLMStreamEvent, LLMStreamEventType} from '../../graphs';
import {AiIntegrationBindings} from '../../keys';
import {PermissionKey} from '../../permissions';
import {HttpTransport} from '../../transports';
import {TestApp} from '../fixtures/test-app';
import {
  buildToken,
  seedCurrencies,
  seedDataset,
  seedEmployees,
  seedExchangeRates,
  setupApplication,
  setupChats,
  setupMessages,
} from '../test-helper';

// All real-model acceptance tests are gated on RUN_WITH_LLM=true (skipped in
// CI). Token grants the table read-permission keys ('1'..'5') so the
// get-tables permission filter does not strip any table.
const TABLE_PERMS = ['1', '2', '3', '4', '5'];

/** POST /generate and return the datasetId from the final tool-status event. */
async function generateDatasetId(
  client: Client,
  token: string,
  prompt: string,
): Promise<string> {
  const response = await client
    .post('/generate')
    .set('authorization', `Bearer ${token}`)
    .field('prompt', prompt)
    .expect(200);
  const body: LLMStreamEvent[] = response.body;
  const toolStatuses = body.filter(
    event => event.type === LLMStreamEventType.ToolStatus,
  );
  const last = toolStatuses[toolStatuses.length - 1];
  return last?.data?.data?.['datasetId'] as string;
}

// ──────────────────────────────────────────────────────────────────
// End-to-end generation (real LLM) — ports v2 db-query.graph.acceptance.
// Asserts the produced dataset's ROWS, including the currency-conversion
// GlobalContext rule (Charlie White salary in USD = 9952.61).
// ──────────────────────────────────────────────────────────────────
describe('GenerationController — end-to-end (real LLM)', () => {
  let app: TestApp;
  let client: Client;
  let datasetStore: IDataSetStore;

  before('checkIfCanRun', function () {
    if (process.env.RUN_WITH_LLM !== 'true') {
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      this.skip();
    }
  });

  before('setupApplication', async () => {
    ({app, client} = await setupApplication({}));
    app
      .bind(AiIntegrationBindings.Transport)
      .toClass(HttpTransport)
      .inScope(BindingScope.REQUEST);
    // v2 db-query.graph.acceptance bound this rule for the conversion cases.
    app
      .bind(DbQueryAIExtensionBindings.GlobalContext)
      .to([
        'Every value with currency_id should be converted to USD before returning to the user.',
      ]);
    await seedEmployees(app);
    await seedCurrencies(app);
    await seedExchangeRates(app);
    await seedDataset(app);
    await setupChats(app);
    await setupMessages(app);
    datasetStore = await app.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
    );
  });

  after(async () => {
    if (app) await app.stop();
  });

  it('converts a single salary to USD with 2 decimals (Charlie White → 9952.61)', async () => {
    const token = buildToken([...TABLE_PERMS, PermissionKey.AskAI]);
    const datasetId = await generateDatasetId(
      client,
      token,
      'Show the salary of the employee Charlie White in USD, the result should ' +
        'just have one column named "salary" with 2 decimal places',
    );
    expect(datasetId).to.be.String();
    const rows = await datasetStore.getData(datasetId);
    expect(rows).to.deepEqual([{salary: 9952.61}]);
  });

  it('filters employees by salary > 8000 USD, names ascending (Charlie White, Nameless Gonbei)', async () => {
    const token = buildToken([...TABLE_PERMS, PermissionKey.AskAI]);
    const datasetId = await generateDatasetId(
      client,
      token,
      'Show all the employees who have salary greater than 8000 USD, the result ' +
        'should have just 1 column `name`, results ordered by name in ascending order',
    );
    expect(datasetId).to.be.String();
    const rows = await datasetStore.getData(datasetId);
    expect(rows).to.deepEqual([
      {name: 'Charlie White'},
      {name: 'Nameless Gonbei'},
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Table selection (real LLM) — ports v2 get-tables-node.acceptance. v2 asserted
// the get-tables node's filtered schema CONTAINS the expected tables. Mastra
// has no standalone node, so we assert the persisted dataset.tables (the
// authoritative table set the read-time ACL gates on) CONTAINS each expected
// table. Contains-check (not exact) — a query may legitimately join more.
// ──────────────────────────────────────────────────────────────────
describe('GenerationController — table selection (real LLM)', () => {
  let app: TestApp;
  let client: Client;
  let datasetStore: IDataSetStore;

  before('checkIfCanRun', function () {
    if (process.env.RUN_WITH_LLM !== 'true') {
      // eslint-disable-next-line @typescript-eslint/no-invalid-this
      this.skip();
    }
  });

  before('setupApplication', async () => {
    ({app, client} = await setupApplication({}));
    app
      .bind(AiIntegrationBindings.Transport)
      .toClass(HttpTransport)
      .inScope(BindingScope.REQUEST);
    // v2 get-tables-node.acceptance ran with no GlobalContext rule.
    app.bind(DbQueryAIExtensionBindings.GlobalContext).to([]);
    await seedEmployees(app);
    await seedCurrencies(app);
    await seedExchangeRates(app);
    await setupChats(app);
    await setupMessages(app);
    datasetStore = await app.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
    );
  });

  after(async () => {
    if (app) await app.stop();
  });

  const cases: Array<{prompt: string; expectedTables: string[]}> = [
    {
      prompt: 'Find all the resources that joined in the last month',
      expectedTables: ['employees'],
    },
    {
      prompt: 'Find all the resources that have salary greater than 1000 USD',
      expectedTables: ['employees', 'exchange_rates'],
    },
    {
      prompt: 'Show all the currencies that do not have any exchange rates',
      expectedTables: ['currencies'],
    },
    {
      prompt:
        'Show the latest exchange rate for each currency with currency name',
      expectedTables: ['currencies', 'exchange_rates'],
    },
  ];

  for (const {prompt, expectedTables} of cases) {
    it(`selects ${expectedTables.join(', ')} for - ${prompt}`, async () => {
      const token = buildToken([...TABLE_PERMS, PermissionKey.AskAI]);
      const datasetId = await generateDatasetId(client, token, prompt);
      expect(datasetId).to.be.String();
      const dataset = await datasetStore.findById(datasetId);
      for (const table of expectedTables) {
        expect(dataset.tables).to.containEql(table);
      }
    });
  }
});

import {BindingScope} from '@loopback/core';
import {Client, expect} from '@loopback/testlab';
import {AuthenticationBindings} from 'loopback4-authentication';
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
  stubUser,
} from '../test-helper';

// All real-model acceptance tests are gated on RUN_WITH_LLM=true (skipped in
// CI). Token grants the table read-permission keys ('1'..'5') so the
// get-tables permission filter does not strip any table.
const TABLE_PERMS = ['1', '2', '3', '4', '5'];

/** POST /reply and return the datasetId from the final tool-status event. */
async function generateDatasetId(
  client: Client,
  token: string,
  prompt: string,
): Promise<string> {
  const response = await client
    .post('/reply')
    .set('authorization', `Bearer ${token}`)
    .field('prompt', prompt)
    .expect(200);
  const body: LLMStreamEvent[] = response.body;
  // The datasetId is emitted on the get-data-as-dataset `tool` event
  // (data.data.datasetId), not on `tool-status` heartbeats.
  const toolEvents = body.filter(
    event =>
      event.type === LLMStreamEventType.Tool &&
      event.data.tool === 'get-data-as-dataset' &&
      event.data.data?.['datasetId'],
  );
  const last = toolEvents[toolEvents.length - 1];
  return (last?.data as {data?: {datasetId?: string}})?.data
    ?.datasetId as string;
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
    // datasetStore.getData runs the SQL through the connector, which requires a
    // current user with a tenantId (the HTTP /reply flow gets one from the
    // bearer token; direct getData calls in the test do not). Bind one on the
    // app context — request-scoped users from real requests still shadow it.
    app
      .bind(AuthenticationBindings.CURRENT_USER)
      .to(stubUser([...TABLE_PERMS, PermissionKey.AskAI]));
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
    // datasetStore.getData runs the SQL through the connector, which requires a
    // current user with a tenantId (the HTTP /reply flow gets one from the
    // bearer token; direct getData calls in the test do not). Bind one on the
    // app context — request-scoped users from real requests still shadow it.
    app
      .bind(AuthenticationBindings.CURRENT_USER)
      .to(stubUser([...TABLE_PERMS, PermissionKey.AskAI]));
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

// ──────────────────────────────────────────────────────────────────
// Follow-up routing (real LLM). Regression guard for the persisted-readout
// bug: turn 1 generates a dataset; turn 2 (SAME session) asks a question ABOUT
// that dataset. The agent MUST route to ask-about-dataset (it holds the SQL),
// not answer from history and guess. Before the readout was neutralised, the
// persisted "do not call any tool again" imperative suppressed the tool call.
// ──────────────────────────────────────────────────────────────────
describe('GenerationController — follow-up routing (real LLM)', () => {
  let app: TestApp;
  let client: Client;

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
    app.bind(DbQueryAIExtensionBindings.GlobalContext).to([]);
    await seedEmployees(app);
    await seedCurrencies(app);
    await seedExchangeRates(app);
    await setupChats(app);
    await setupMessages(app);
    app
      .bind(AuthenticationBindings.CURRENT_USER)
      .to(stubUser([...TABLE_PERMS, PermissionKey.AskAI]));
  });

  after(async () => {
    if (app) await app.stop();
  });

  async function reply(
    token: string,
    prompt: string,
    sessionId?: string,
  ): Promise<LLMStreamEvent[]> {
    let req = client
      .post('/reply')
      .set('authorization', `Bearer ${token}`)
      .field('prompt', prompt);
    if (sessionId) req = req.field('sessionId', sessionId);
    const response = await req.expect(200);
    return response.body as LLMStreamEvent[];
  }

  function calledTool(events: LLMStreamEvent[], tool: string): boolean {
    return events.some(
      e => e.type === LLMStreamEventType.Tool && e.data.tool === tool,
    );
  }

  function sessionIdOf(events: LLMStreamEvent[]): string {
    const init = events.find(e => e.type === LLMStreamEventType.Init);
    return (init?.data as {sessionId?: string})?.sessionId as string;
  }

  it('routes a follow-up question about the prior dataset to ask-about-dataset', async () => {
    const token = buildToken([...TABLE_PERMS, PermissionKey.AskAI]);

    // Turn 1 — new conversation (no sessionId): backend creates the thread and
    // emits its id on the Init event. Generates a date-filtered dataset.
    const turn1 = await reply(
      token,
      'Show all the resources that joined in the last month',
    );
    expect(calledTool(turn1, 'get-data-as-dataset')).to.be.true();
    const sessionId = sessionIdOf(turn1);
    expect(sessionId).to.be.String();

    // Turn 2 — same session: ask ABOUT that dataset. Must call
    // ask-about-dataset (it can read the SQL) rather than guessing.
    const turn2 = await reply(
      token,
      'on which column did you apply the joined-date condition?',
      sessionId,
    );
    expect(calledTool(turn2, 'ask-about-dataset')).to.be.true();
  });
});

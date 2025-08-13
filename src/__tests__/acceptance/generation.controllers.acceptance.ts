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

describe('GenerationController', () => {
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
    if (app) {
      await app.stop();
    }
  });

  it('should trigger a generation that produces events', async () => {
    const token = buildToken(['1', '2', '3', '4', '5', PermissionKey.AskAI]);

    const response = await client
      .post('/generate')
      .set('authorization', `Bearer ${token}`)
      .field(
        'prompt',
        'Show me the names of all the employees with salary greater than 8000 USD, the result should just have 1 column `name` in arranged in ascending order',
      )
      .expect(200);

    const body: LLMStreamEvent[] = response.body;

    const toolStatuses = body.filter(
      event => event.type === LLMStreamEventType.ToolStatus,
    );
    const lastToolStatus = toolStatuses[toolStatuses.length - 1];

    const datasetId = lastToolStatus.data.data?.['datasetId'];
    expect(datasetId).to.be.String();

    const datasetData = await datasetStore.getData(datasetId);
    expect(datasetData).to.be.Array();
    // refer the test employee data in seed-data.ts
    expect(datasetData).to.have.length(2);
    expect(datasetData[0].name).to.equal('Charlie White');
    expect(datasetData[1].name).to.equal('Nameless Gonbei');
  });
});

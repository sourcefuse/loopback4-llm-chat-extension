import {juggler} from '@loopback/repository';
import {
  createStubInstance,
  expect,
  sinon,
  StubbedInstanceWithSinonAccessor,
} from '@loopback/testlab';
import {
  DbQueryState,
  DbSchemaHelperService,
  GetTablesNode,
  SchemaStore,
  SqliteConnector,
  TableSearchService,
} from '../../../../components';
import {LLMProvider} from '../../../../types';
import {
  Currency,
  Employee,
  EmployeeSkill,
  ExchangeRate,
  Skill,
} from '../../../fixtures/models';

describe('GetTablesNode Unit', function () {
  let node: GetTablesNode;
  let llmStub: sinon.SinonStub;
  let schemaHelper: DbSchemaHelperService;
  let schemaStore: SchemaStore;
  let tableSearchStub: StubbedInstanceWithSinonAccessor<TableSearchService>;

  beforeEach(async () => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as LLMProvider;

    schemaHelper = new DbSchemaHelperService(
      new SqliteConnector(
        new juggler.DataSource({
          connector: 'sqlite3',
          file: ':memory:',
          name: 'db',
          debug: true,
        }),
      ),
    );
    schemaStore = new SchemaStore();
    tableSearchStub = createStubInstance(TableSearchService);
    node = new GetTablesNode(llm, schemaHelper, schemaStore, tableSearchStub, [
      'test context',
    ]);
  });

  it('should return state with minimal schema based on prompt and table search', async () => {
    tableSearchStub.stubs.getTables.resolves(['employees', 'exchange_rates']);
    const originalSchema = schemaHelper.modelToSchema('', [
      Employee,
      ExchangeRate,
      Currency,
      Skill,
      EmployeeSkill,
    ]);
    await schemaStore.save(originalSchema);

    const state = {
      prompt: 'Get me the employee with name Akshat',
      schema: originalSchema,
    } as unknown as DbQueryState;

    llmStub.resolves({content: 'employees'});

    const result = await node.execute(state, {});

    expect(llmStub.getCalls()[0].args[0].value.trim()).equal(
      `You are an AI assistant that extracts table names that are relevant to the users query that will be used to generate an SQL query later.,
    here is the list of all the tables available with their descriptions:
    employees: ${Employee.definition.settings.description}

exchange_rates: ${ExchangeRate.definition.settings.description}

    and here is the user query:
    Get me the employee with name Akshat

    You must keep these additional details in consideration -
test context
employee salary must be converted to USD, using the currency_id column and the exchange rate table

    

    Please extract the relevant table names and return them as a comma separated list. Note there should be nothing else other than a comma separated list of exact same table names as in the input.
    Ensure that table names are exact and match the names in the input including schema if given.
    Use only and only the tables that are relevant to the query.
    If you are not sure about the tables to select from the given schema, just return your doubt asking the user for more details or to rephrase the question in the following format - 
    failed attempt: <reason for failure>`,
    );

    expect(result.schema).to.deepEqual(
      schemaStore.filteredSchema(['employees']),
    );
  });

  it('should return throw error if now table available in schema', async () => {
    tableSearchStub.stubs.getTables.resolves([]);
    const originalSchema = schemaHelper.modelToSchema('', [
      Employee,
      ExchangeRate,
      Currency,
      Skill,
      EmployeeSkill,
    ]);
    await schemaStore.save(originalSchema);

    const state = {
      prompt: 'Get me the employee with name Akshat',
      schema: originalSchema,
    } as unknown as DbQueryState;

    llmStub.resolves({content: 'employees'});

    await expect(node.execute(state, {})).to.be.rejectedWith(
      'No tables found in the provided database schema. Please ensure the schema is valid.',
    );
  });
});

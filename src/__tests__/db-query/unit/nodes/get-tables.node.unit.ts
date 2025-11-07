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
import {IAuthUserWithPermissions} from 'loopback4-authorization';

describe('GetTablesNode Unit', function () {
  let node: GetTablesNode;
  let smartllmStub: sinon.SinonStub;
  let dumbllmStub: sinon.SinonStub;
  let schemaHelper: DbSchemaHelperService;
  let schemaStore: SchemaStore;
  let tableSearchStub: StubbedInstanceWithSinonAccessor<TableSearchService>;

  beforeEach(async () => {
    smartllmStub = sinon.stub();
    dumbllmStub = sinon.stub();
    const llm = dumbllmStub as unknown as LLMProvider;

    schemaHelper = new DbSchemaHelperService(
      new SqliteConnector(
        new juggler.DataSource({
          connector: 'sqlite3',
          file: ':memory:',
          name: 'db',
          debug: true,
        }),
        {} as unknown as IAuthUserWithPermissions,
      ),
      {models: []},
    );
    schemaStore = new SchemaStore();
    tableSearchStub = createStubInstance(TableSearchService);
    node = new GetTablesNode(
      llm,
      dumbllmStub as unknown as LLMProvider,
      {
        models: [],
      },
      schemaHelper,
      schemaStore,
      tableSearchStub,
      ['test context'],
    );
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

    dumbllmStub.resolves({
      content: 'employees',
    });

    const result = await node.execute(state, {});

    expect(dumbllmStub.getCalls()[0].args[0].value.trim()).equal(
      `<instructions>
You are an AI assistant that extracts table names that are relevant to the users query that will be used to generate an SQL query later.
- Consider not just the user query but also the context and the table descriptions while selecting the tables.
- Carefully consider each and every table before including or excluding it.
- If doubtful about a table's relevance, include it anyway to give the SQL generation step more options to choose from.
- Assume that the table would have appropriate columns for relating them to any other table even if the description does not mention it.
- If you are not sure about the tables to select from the given schema, just return your doubt asking the user for more details or to rephrase the question in the following format -
failed attempt: reason for failure
</instructions>

<tables-with-description>
employees: ${Employee.definition.settings.description}

exchange_rates: ${ExchangeRate.definition.settings.description}
</tables-with-description>

<user-question>
Get me the employee with name Akshat
</user-question>

<must-follow-rules>
- test context
- employee salary must be converted to USD, using the currency_id column and the exchange rate table
</must-follow-rules>



<output-format>
The output should be just a comma separated list of table names with no other text, comments or formatting.
Ensure that table names are exact and match the names in the input including schema if given.
<example-output>
public.employees, public.departments
</example-output>
In case of failure, return the failure message in the format -
failed attempt: <reason for failure>
<example-failure>
failed attempt: reason for failure
</example-failure>
</output-format>`,
    );

    expect(result.schema).to.deepEqual(
      schemaStore.filteredSchema(['employees']),
    );
  });

  it('should return state with minimal schema based on prompt and table search with smart llm', async () => {
    node = new GetTablesNode(
      dumbllmStub as unknown as LLMProvider,
      smartllmStub as unknown as LLMProvider,
      {
        models: [],
        nodes: {
          // config to use smart llm for this node
          getTablesNode: {
            useSmartLLM: true,
          },
        },
      },
      schemaHelper,
      schemaStore,
      tableSearchStub,
      ['test context'],
    );
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

    smartllmStub.resolves({
      content: 'employees',
    });

    const result = await node.execute(state, {});

    expect(smartllmStub.getCalls()[0].args[0].value.trim()).equal(
      `<instructions>
You are an AI assistant that extracts table names that are relevant to the users query that will be used to generate an SQL query later.
- Consider not just the user query but also the context and the table descriptions while selecting the tables.
- Carefully consider each and every table before including or excluding it.
- If doubtful about a table's relevance, include it anyway to give the SQL generation step more options to choose from.
- Assume that the table would have appropriate columns for relating them to any other table even if the description does not mention it.
- If you are not sure about the tables to select from the given schema, just return your doubt asking the user for more details or to rephrase the question in the following format -
failed attempt: reason for failure
</instructions>

<tables-with-description>
employees: ${Employee.definition.settings.description}

exchange_rates: ${ExchangeRate.definition.settings.description}
</tables-with-description>

<user-question>
Get me the employee with name Akshat
</user-question>

<must-follow-rules>
- test context
- employee salary must be converted to USD, using the currency_id column and the exchange rate table
</must-follow-rules>



<output-format>
The output should be just a comma separated list of table names with no other text, comments or formatting.
Ensure that table names are exact and match the names in the input including schema if given.
<example-output>
public.employees, public.departments
</example-output>
In case of failure, return the failure message in the format -
failed attempt: <reason for failure>
<example-failure>
failed attempt: reason for failure
</example-failure>
</output-format>`,
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

    dumbllmStub.resolves({
      content: 'employees',
    });

    await expect(node.execute(state, {})).to.be.rejectedWith(
      'No tables found in the provided database schema. Please ensure the schema is valid.',
    );
  });

  it('should retry selection if table names are not valid', async () => {
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

    dumbllmStub.onFirstCall().resolves({
      content: 'non_existing_table',
    });
    dumbllmStub.onSecondCall().resolves({
      content: 'employees',
    });

    const result = await node.execute(state, {});

    expect(dumbllmStub.callCount).to.equal(2);
    expect(result.schema).to.deepEqual(
      schemaStore.filteredSchema(['employees']),
    );
  });
});

import {juggler} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {
  DbQueryState,
  DbSchemaHelperService,
  GenerationError,
  GetColumnsNode,
  SqliteConnector,
} from '../../../../components';
import {createMockLLM, MockLLM} from '../../../test-helper';
import {Employee, ExchangeRate} from '../../../fixtures/models';
import {IAuthUserWithPermissions} from 'loopback4-authorization';

describe('GetColumnsNode Unit', function () {
  let node: GetColumnsNode;
  let llm: MockLLM;
  let schemaHelper: DbSchemaHelperService;

  beforeEach(async () => {
    llm = createMockLLM();

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

    node = new GetColumnsNode(
      llm.model,
      schemaHelper,
      {
        models: [],
        columnSelection: true,
      },
      ['test context'],
    );
  });

  it('should return state with filtered schema containing only relevant columns', async () => {
    const originalSchema = schemaHelper.modelToSchema('', [
      Employee,
      ExchangeRate,
    ]);

    // Create a state with filtered tables (simulating output from get-tables node)
    const filteredSchema = {
      tables: {
        employees: originalSchema.tables.employees,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        exchange_rates: originalSchema.tables.exchange_rates,
      },
      relations: originalSchema.relations.filter(
        r =>
          (r.table === 'employees' || r.table === 'exchange_rates') &&
          (r.referencedTable === 'employees' ||
            r.referencedTable === 'exchange_rates'),
      ),
    };

    const state = {
      prompt: 'Get me the employee with name Akshat and their salary in USD',
      schema: filteredSchema,
    } as unknown as DbQueryState;

    // Mock LLM response with selected columns
    llm.setText(
      '{\n  "employees": ["name", "salary", "currency_id"],\n  "exchange_rates": ["currency_id", "rate"]\n}',
    );

    const result = await node.execute(state, {});

    // Verify that the schema is filtered and contains the expected tables
    expect(result.schema?.tables).to.have.property('employees');
    expect(result.schema?.tables).to.have.property('exchange_rates');

    // Verify that employees table has the selected columns plus primary key
    const employeeColumns = Object.keys(
      result.schema?.tables.employees.columns || {},
    );
    expect(employeeColumns).to.containEql('id');
    expect(employeeColumns).to.containEql('name');
    expect(employeeColumns).to.containEql('salary');
    expect(employeeColumns).to.containEql('currency_id');

    // Verify that exchange_rates table has the selected columns plus primary key
    const exchangeRateColumns = Object.keys(
      result.schema?.tables.exchange_rates.columns || {},
    );
    expect(exchangeRateColumns).to.containEql('id');
    expect(exchangeRateColumns).to.containEql('currency_id');
    expect(exchangeRateColumns).to.containEql('rate');
  });

  it('should handle failed attempt response from LLM', async () => {
    const originalSchema = schemaHelper.modelToSchema('', [Employee]);
    const filteredSchema = {
      tables: {
        employees: originalSchema.tables.employees,
      },
      relations: [],
    };

    const state = {
      prompt: 'Some ambiguous query',
      schema: filteredSchema,
    } as unknown as DbQueryState;

    llm.setText(
      'failed attempt: Query is too ambiguous to determine relevant columns',
    );

    const result = await node.execute(state, {});

    expect(result.status).to.equal(GenerationError.Failed);
    expect(result.replyToUser).to.equal(
      'Query is too ambiguous to determine relevant columns',
    );
  });

  it('should throw error if no tables in schema', async () => {
    const state = {
      prompt: 'Get me some data',
      schema: {tables: {}, relations: []},
    } as unknown as DbQueryState;

    await expect(node.execute(state, {})).to.be.rejectedWith(
      'No tables found in the schema. Please ensure the get-tables step was completed successfully.',
    );
  });

  it('should include primary key columns even if not explicitly selected', async () => {
    const originalSchema = schemaHelper.modelToSchema('', [Employee]);
    const filteredSchema = {
      tables: {
        employees: originalSchema.tables.employees,
      },
      relations: [],
    };

    const state = {
      prompt: 'Get employee names',
      schema: filteredSchema,
    } as unknown as DbQueryState;

    // Mock LLM response that doesn't include primary key
    llm.setText('{\n  "employees": ["name"]\n}');

    const result = await node.execute(state, {});

    // Should include both selected column and primary key
    const employeeColumns = Object.keys(
      result.schema?.tables.employees.columns || {},
    );
    expect(employeeColumns).to.containEql('id');
    expect(employeeColumns).to.containEql('name');
  });
});

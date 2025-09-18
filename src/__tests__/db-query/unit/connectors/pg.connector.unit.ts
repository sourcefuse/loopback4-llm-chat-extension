import {juggler} from '@loopback/repository';
import {DbSchemaHelperService, PgConnector} from '../../../../components';
import {Employee} from '../../../fixtures/models';
import {expect} from '@loopback/testlab';

describe(`PgConnector Unit`, () => {
  let connector: PgConnector;
  let dbSchemaHelper: DbSchemaHelperService;
  beforeEach(() => {
    const ds = new juggler.DataSource({
      name: 'db',
      connector: 'memory',
    });
    connector = new PgConnector(ds);
    dbSchemaHelper = new DbSchemaHelperService(connector, {models: []});
  });

  it('should transform a model correctly', () => {
    const schema = dbSchemaHelper.modelToSchema('public', [Employee]);
    const ddl = connector.toDDL(schema);
    expect(ddl).to.be.equal(`-- Model representing an employee in the system.
CREATE TABLE public.employees (
 -- Unique identifier for the employee record
  id UUID NOT NULL,
 -- Name of the employee
  name TEXT NOT NULL,
 -- Unique code for the employee, used for identification
  code TEXT NOT NULL,
 -- The salary of the employee in the currency stored in currency_id column
  salary INTEGER NOT NULL,
 -- The date when the employee joined the company
  joiningdate DATE NOT NULL,
 -- The ID of the currency for the employees salary. Use this to convert the salary to USD along with the exchange rate table.
  currency_id UUID,
  PRIMARY KEY (id)
);`);
  });
});

import {juggler} from '@loopback/repository';
import {DbSchemaHelperService, PgConnector} from '../../../../components';
import {Employee} from '../../../fixtures/models';
import {expect} from '@loopback/testlab';
import {IAuthUserWithPermissions} from 'loopback4-authorization';

describe(`PgConnector Unit`, () => {
  let connector: PgConnector;
  let dbSchemaHelper: DbSchemaHelperService;
  beforeEach(() => {
    const ds = new juggler.DataSource({
      name: 'db',
      connector: 'memory',
    });
    const user = {
      userTenantId: 'test-tenant',
    } as unknown as IAuthUserWithPermissions;
    connector = new PgConnector(ds, user);
    dbSchemaHelper = new DbSchemaHelperService(connector, {models: []});
  });

  it('should transform a model correctly', () => {
    const schema = dbSchemaHelper.modelToSchema('public', [Employee]);
    const ddl = connector.toDDL(schema);
    expect(ddl).to.be.equal(`-- Model representing an employee in the system.
CREATE TABLE public.employees (
 -- Unique identifier for the employee record
  id UUID,
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

  describe('_cleanQuery method', () => {
    it('should remove trailing semicolons', () => {
      const query = 'SELECT * FROM employees;';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });

    it('should remove trailing semicolons with whitespace', () => {
      const query = 'SELECT * FROM employees;   ';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });

    it('should remove single-line comments', () => {
      const query = 'SELECT * FROM employees -- This is a comment';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });

    it('should remove single-line comments with trailing semicolon', () => {
      const query = 'SELECT * FROM employees; -- This is a comment';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });

    it('should remove multi-line comments', () => {
      const query =
        'SELECT * FROM employees /* This is a\nmulti-line comment */';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });

    it('should remove multi-line comments with trailing semicolon', () => {
      const query =
        'SELECT * FROM employees; /* This is a\nmulti-line comment */';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });

    it('should clean query with both comments and semicolons', () => {
      const query = 'SELECT * FROM employees; -- Get all employees\n  ';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });

    it('should handle complex query without changes', () => {
      const query =
        'SELECT e.name, e.salary FROM employees e JOIN departments d ON e.id = d.employee_id WHERE e.salary > 50000';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal(query);
    });

    it('should handle query with inline comments unchanged', () => {
      const query =
        "SELECT name, salary FROM employees WHERE department = 'sales' -- Get sales employees";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal(
        "SELECT name, salary FROM employees WHERE department = 'sales'",
      );
    });

    it('should clean nested comments and semicolons', () => {
      const query =
        'SELECT * FROM employees; /* Another comment */ ; ;; -- Final comment';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned = (connector as any)._cleanQuery(query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });
  });
});

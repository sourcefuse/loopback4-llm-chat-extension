import {juggler, Transaction} from '@loopback/repository';
import {expect, sinon} from '@loopback/testlab';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {PgWithRlsConnector} from '../../../../components/db-query/connectors/pg/rls-pg.connector';
import {fail} from 'assert';

describe('PgWithRlsConnector Unit', () => {
  let connector: PgWithRlsConnector;
  let mockDb: sinon.SinonStubbedInstance<juggler.DataSource>;
  let mockTransaction: sinon.SinonStubbedInstance<Transaction>;
  let user: IAuthUserWithPermissions;

  beforeEach(() => {
    mockDb = sinon.createStubInstance(juggler.DataSource);
    mockTransaction = {
      commit: sinon.stub().resolves(),
      rollback: sinon.stub().resolves(),
    } as unknown as sinon.SinonStubbedInstance<Transaction>;

    user = {
      userTenantId: 'test-tenant',
      tenantId: 'test-tenant',
    } as unknown as IAuthUserWithPermissions;
  });

  describe('_execute method with RLS', () => {
    it('should set RLS conditions and execute query when defaultConditions are provided', async () => {
      const query = 'SELECT * FROM employees';
      const params = ['param1', 'param2'];
      const defaultConditions = {tenantId: 'test-tenant', userId: 'user123'};

      mockDb.beginTransaction.resolves(mockTransaction);
      mockTransaction.commit.resolves();
      mockDb.execute
        .withArgs(
          "SELECT set_config('app.tenantId', $1, true);",
          ['test-tenant'],
          {transaction: mockTransaction},
        )
        .resolves();
      mockDb.execute
        .withArgs("SELECT set_config('app.userId', $1, true);", ['user123'], {
          transaction: mockTransaction,
        })
        .resolves();
      mockDb.execute
        .withArgs(query, params, {transaction: mockTransaction})
        .resolves([{id: 1, name: 'John'}]);

      connector = new PgWithRlsConnector(mockDb, user, defaultConditions);

      const result = await connector['_execute'](query, params);

      expect(result).to.deepEqual([{id: 1, name: 'John'}]);
      expect(mockDb.beginTransaction.calledOnce).to.be.true();
      expect(mockDb.execute.calledThrice).to.be.true();
      expect(mockTransaction.commit.calledOnce).to.be.true();
    });

    it('should execute query without setting RLS conditions when defaultConditions are not provided', async () => {
      const query = 'SELECT * FROM employees';
      const params = ['param1', 'param2'];

      mockDb.beginTransaction.resolves(mockTransaction);
      mockTransaction.commit.resolves();
      mockDb.execute
        .withArgs(query, params, {transaction: mockTransaction})
        .resolves([{id: 1, name: 'John'}]);

      connector = new PgWithRlsConnector(mockDb, user);

      const result = await connector['_execute'](query, params);

      expect(result).to.deepEqual([{id: 1, name: 'John'}]);
      expect(mockDb.beginTransaction.calledOnce).to.be.true();
      expect(mockDb.execute.calledOnce).to.be.true();
      expect(mockTransaction.commit.calledOnce).to.be.true();
    });

    it('should rollback transaction when an error occurs', async () => {
      const query = 'SELECT * FROM employees';
      const defaultConditions = {tenantId: 'test-tenant'};

      mockDb.beginTransaction.resolves(mockTransaction);
      mockTransaction.rollback.resolves();
      mockDb.execute.rejects(new Error('Database error'));

      connector = new PgWithRlsConnector(mockDb, user, defaultConditions);

      try {
        await connector.execute(query);
        fail('Expected error was not thrown');
      } catch (error) {
        expect(error.message).to.equal('Database error');
      }
      expect(mockDb.beginTransaction.calledOnce).to.be.true();
      expect(mockTransaction.rollback.calledOnce).to.be.true();
    });

    it('should handle empty defaultConditions object', async () => {
      const query = 'SELECT * FROM employees';
      const params = ['param1', 'param2'];
      const defaultConditions = {};

      mockDb.beginTransaction.resolves(mockTransaction);
      mockTransaction.commit.resolves();
      mockDb.execute
        .withArgs(query, params, {transaction: mockTransaction})
        .resolves([{id: 1, name: 'John'}]);

      connector = new PgWithRlsConnector(mockDb, user, defaultConditions);

      const result = await connector['_execute'](query, params);

      expect(result).to.deepEqual([{id: 1, name: 'John'}]);
      expect(mockDb.beginTransaction.calledOnce).to.be.true();
      expect(mockDb.execute.calledOnce).to.be.true();
      expect(mockTransaction.commit.calledOnce).to.be.true();
    });
  });

  describe('execute method with RLS', () => {
    it('should add limit and offset to query', async () => {
      const query = 'SELECT * FROM employees';
      const limit = 10;
      const offset = 5;
      const params = ['param1', 'param2'];
      const defaultConditions = {tenantId: 'test-tenant'};

      mockDb.beginTransaction.resolves(mockTransaction);
      mockTransaction.commit.resolves();
      mockDb.execute
        .withArgs(
          "SELECT set_config('app.tenantId', $1, true);",
          ['test-tenant'],
          {transaction: mockTransaction},
        )
        .resolves();
      mockDb.execute
        .withArgs(
          'SELECT * FROM (SELECT * FROM employees) AS subquery LIMIT $3 OFFSET $4;',
          [limit, offset],
          {transaction: mockTransaction},
        )
        .resolves([{id: 1, name: 'John'}]);

      connector = new PgWithRlsConnector(mockDb, user, defaultConditions);

      const result = await connector.execute(query, limit, offset, params);
      expect(result).to.deepEqual([{id: 1, name: 'John'}]);
    });

    it('should execute query with limit only', async () => {
      const query = 'SELECT * FROM employees';
      const limit = 10;
      const params = ['param1', 'param2'];
      const defaultConditions = {tenantId: 'test-tenant'};

      mockDb.beginTransaction.resolves(mockTransaction);
      mockTransaction.commit.resolves();
      mockDb.execute
        .withArgs(
          "SELECT set_config('app.tenantId', $1, true);",
          ['test-tenant'],
          {transaction: mockTransaction},
        )
        .resolves();
      mockDb.execute
        .withArgs(
          'SELECT * FROM (SELECT * FROM employees) AS subquery LIMIT $3;',
          [limit],
          {transaction: mockTransaction},
        )
        .resolves([{id: 1, name: 'John'}]);

      connector = new PgWithRlsConnector(mockDb, user, defaultConditions);

      const result = await connector.execute(query, limit, undefined, params);
      expect(result).to.deepEqual([{id: 1, name: 'John'}]);
    });

    it('should execute query with offset only', async () => {
      const query = 'SELECT * FROM employees';
      const offset = 5;
      const params = ['param1', 'param2'];
      const defaultConditions = {tenantId: 'test-tenant'};

      mockDb.beginTransaction.resolves(mockTransaction);
      mockTransaction.commit.resolves();
      mockDb.execute
        .withArgs(
          "SELECT set_config('app.tenantId', $1, true);",
          ['test-tenant'],
          {transaction: mockTransaction},
        )
        .resolves();
      mockDb.execute
        .withArgs(
          'SELECT * FROM (SELECT * FROM employees) AS subquery OFFSET $3;',
          [offset],
          {transaction: mockTransaction},
        )
        .resolves([{id: 1, name: 'John'}]);

      connector = new PgWithRlsConnector(mockDb, user, defaultConditions);

      const result = await connector.execute(query, undefined, offset, params);
      expect(result).to.deepEqual([{id: 1, name: 'John'}]);
    });
  });

  describe('inherited methods', () => {
    it('should correctly generate DDL from database schema', async () => {
      const dbSchema = {
        tables: {
          employees: {
            columns: {
              id: {
                type: 'string',
                required: true,
                description: 'Unique identifier for the employee record',
                id: true,
              },
              name: {
                type: 'string',
                required: true,
                description: 'Name of the employee',
                id: false,
              },
            },
            primaryKey: ['id'],
            description: 'Model representing an employee in the system.',
            context: [],
            hash: 'hash123',
          },
        },
        relations: [],
      };

      mockDb = sinon.createStubInstance(juggler.DataSource);
      connector = new PgWithRlsConnector(mockDb, user);

      const ddl = connector.toDDL(dbSchema);
      expect(ddl).to.be.String();
      expect(ddl).to.match(/CREATE TABLE employees/);
      expect(ddl).to.match(/id UUID NOT NULL/);
      expect(ddl).to.match(/name TEXT NOT NULL/);
    });

    it('should correctly clean queries', async () => {
      mockDb = sinon.createStubInstance(juggler.DataSource);
      connector = new PgWithRlsConnector(mockDb, user);

      const query = 'SELECT * FROM employees; -- Get all employees';
      const cleaned = connector['_cleanQuery'](query);
      expect(cleaned).to.equal('SELECT * FROM employees');
    });
  });
});

import {expect} from '@loopback/testlab';
import {SqlValidatorService} from '../../components/db-query/services/sql-validator.service';

const validator = new SqlValidatorService();
const detectDmlStatement = (sql: string) => validator.detectDml(sql);
const validateSqlSyntactic = validator.validateSyntactic.bind(validator);

// Defence-in-depth: LLM-generated SQL must be read-only before it is
// validated / persisted / executed. The connector wraps execution in
// `SELECT * FROM (<sql>) AS subquery` (which blocks a bare DML statement),
// but a data-modifying CTE survives that wrap — so the guard must catch DML
// anywhere, including inside a WITH clause.
describe('detectDmlStatement (read-only SQL guard)', () => {
  it('passes plain SELECT queries', () => {
    expect(
      detectDmlStatement('SELECT * FROM users WHERE id = 1'),
    ).to.be.undefined();
  });

  it('passes a read-only CTE', () => {
    expect(
      detectDmlStatement(
        'WITH recent AS (SELECT id FROM orders ORDER BY created_at DESC LIMIT 10) SELECT * FROM recent',
      ),
    ).to.be.undefined();
  });

  it('flags a bare DELETE', () => {
    expect(detectDmlStatement('DELETE FROM users WHERE id = 1')).to.equal(
      'DELETE',
    );
  });

  it('flags INSERT / UPDATE / TRUNCATE / DROP', () => {
    expect(detectDmlStatement('INSERT INTO t (a) VALUES (1)')).to.equal(
      'INSERT',
    );
    expect(detectDmlStatement('UPDATE t SET a = 1 WHERE id = 2')).to.equal(
      'UPDATE',
    );
    expect(detectDmlStatement('TRUNCATE TABLE t')).to.equal('TRUNCATE');
    expect(detectDmlStatement('DROP TABLE t')).to.equal('DROP');
  });

  it('flags a data-modifying CTE that the subquery wrap would not block', () => {
    expect(
      detectDmlStatement(
        'WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d',
      ),
    ).to.equal('DELETE');
  });

  it('does not false-positive on column/identifier names that reuse keywords', () => {
    expect(
      detectDmlStatement(
        'SELECT update_date, deleted_flag, created_by FROM audit_log',
      ),
    ).to.be.undefined();
  });

  it('does not false-positive on keywords inside string literals', () => {
    expect(
      detectDmlStatement(
        "SELECT * FROM notes WHERE body = 'please delete from the queue'",
      ),
    ).to.be.undefined();
  });
});

describe('validateSqlSyntactic read-only enforcement', () => {
  it('rejects DML before touching the connector', async () => {
    let validateCalled = false;
    const connector = {
      validate: async () => {
        validateCalled = true;
      },
    } as never;
    const res = await validateSqlSyntactic(
      'WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d',
      connector,
    );
    expect(res.passed).to.be.false();
    expect(res.feedback).to.match(/read-only/i);
    // The guard must short-circuit before the (executing) connector path.
    expect(validateCalled).to.be.false();
  });

  it('lets a read-only query through to the connector validator', async () => {
    let validateCalled = false;
    const connector = {
      validate: async () => {
        validateCalled = true;
      },
    } as never;
    const res = await validateSqlSyntactic('SELECT 1', connector);
    expect(res.passed).to.be.true();
    expect(validateCalled).to.be.true();
  });
});

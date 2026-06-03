import {expect, sinon} from '@loopback/testlab';
import {createMockModel} from '@mastra/core/test-utils/llm-mock';
import type {LanguageModel} from 'ai';
import type {IDbConnector} from '../../../components/db-query/types';
import {
  buildGenerateSqlPrompt,
  generateSqlOnce,
  idToString,
  pickRelevantTables,
  resolvePersistDeps,
  runSqlAttempt,
  stripJsonFences,
  stripSqlFences,
  validateSqlSemantic,
  validateSqlSyntactic,
} from '../../../mastra/workflows/db-query/_helpers';

/**
 * Faithful unit coverage for the db-query workflow's SQL-generation +
 * validation helpers. Replaces the deleted v2 node unit tests
 * (sql-generation.node, syntactic-validator.node, semantic-validator.node,
 * get-columns.node, save-dataset-node) — the node classes were collapsed
 * into these `_helpers` functions during the LangGraph → Mastra migration,
 * so the equivalent behaviour is asserted here.
 */
describe('db-query generate helpers (unit)', () => {
  const model = (text: string): LanguageModel =>
    createMockModel({
      mockText: text,
      version: 'v2',
    }) as unknown as LanguageModel;
  const throwingModel = (): LanguageModel =>
    ({
      specificationVersion: 'v2',
      provider: 'test',
      modelId: 'boom',
      doGenerate: async () => {
        throw new Error('LLM down');
      },
      doStream: async () => {
        throw new Error('LLM down');
      },
    }) as unknown as LanguageModel;

  describe('idToString', () => {
    it('coerces a numeric DB id to string', () => {
      expect(idToString(167)).to.equal('167');
    });
    it('passes a string id through', () => {
      expect(idToString('abc')).to.equal('abc');
    });
    it('returns empty string for null/undefined', () => {
      expect(idToString(null)).to.equal('');
      expect(idToString(undefined)).to.equal('');
    });
  });

  describe('fence stripping', () => {
    it('strips ```sql fences', () => {
      expect(stripSqlFences('```sql\nSELECT 1\n```')).to.equal('SELECT 1');
    });
    it('strips ```json fences', () => {
      expect(stripJsonFences('```json\n{"a":1}\n```')).to.equal('{"a":1}');
    });
    it('leaves unfenced text untouched', () => {
      expect(stripSqlFences('SELECT 1')).to.equal('SELECT 1');
    });
  });

  describe('buildGenerateSqlPrompt', () => {
    it('includes the user request, allowed tables/columns and checklist', () => {
      const p = buildGenerateSqlPrompt({
        prompt: 'list employees',
        tables: ['employees'],
        columns: {employees: ['id', 'name']},
        checklist: '- only active',
      });
      expect(p).to.match(/list employees/);
      expect(p).to.match(/employees/);
      expect(p).to.match(/only active/);
    });
    it('renders prior-attempt feedback when present', () => {
      const p = buildGenerateSqlPrompt({
        prompt: 'x',
        tables: ['t'],
        feedback: 'Syntactic error: near EXTRACT',
      });
      expect(p).to.match(/near EXTRACT/);
    });
  });

  describe('generateSqlOnce', () => {
    it('returns stripped SQL on success', async () => {
      const res = await generateSqlOnce(
        model('```sql\nSELECT * FROM employees;\n```'),
        'gen sql',
      );
      expect(res.sql).to.equal('SELECT * FROM employees;');
      expect(res.error).to.be.undefined();
    });
    it('returns an error (no SQL) when the model throws', async () => {
      const res = await generateSqlOnce(throwingModel(), 'gen sql');
      expect(res.sql).to.equal('');
      expect(res.error).to.match(/LLM down/);
    });
  });

  describe('validateSqlSyntactic', () => {
    it('passes when the connector validates the SQL', async () => {
      const conn = {
        validate: sinon.stub().resolves(),
      } as unknown as IDbConnector;
      expect(await validateSqlSyntactic('SELECT 1', conn)).to.eql({
        passed: true,
      });
    });
    it('fails with feedback when the connector rejects', async () => {
      const conn = {
        validate: sinon.stub().rejects(new Error('near ")": syntax error')),
      } as unknown as IDbConnector;
      const r = await validateSqlSyntactic('SELECT (', conn);
      expect(r.passed).to.be.false();
      expect(r.feedback).to.match(/syntax error/);
    });
    it('is a no-op pass when no connector is bound', async () => {
      expect(await validateSqlSyntactic('SELECT 1', undefined)).to.eql({
        passed: true,
      });
    });
  });

  describe('validateSqlSemantic', () => {
    const base = {sql: 'SELECT 1', prompt: 'q', checklist: '- a'};
    it('passes on a <valid/> verdict', async () => {
      const r = await validateSqlSemantic({
        ...base,
        chatLlm: model('<valid/>'),
      });
      expect(r.passed).to.be.true();
    });
    it('fails on an <invalid> verdict and surfaces the reason', async () => {
      const r = await validateSqlSemantic({
        ...base,
        chatLlm: model('<invalid>missing the active-rate filter</invalid>'),
      });
      expect(r.passed).to.be.false();
      expect(r.feedback).to.match(/active-rate filter/);
    });
    it('defaults to PASS when the judge returns neither tag (lenient)', async () => {
      const r = await validateSqlSemantic({
        ...base,
        chatLlm: model('looks fine to me'),
      });
      expect(r.passed).to.be.true();
    });
    it('passes (skips) when no checklist is supplied', async () => {
      const r = await validateSqlSemantic({
        sql: 'SELECT 1',
        prompt: 'q',
        chatLlm: model('<invalid>x</invalid>'),
      });
      expect(r.passed).to.be.true();
    });
    it('passes when the judge errors (advisory only)', async () => {
      const r = await validateSqlSemantic({...base, chatLlm: throwingModel()});
      expect(r.passed).to.be.true();
    });
  });

  describe('runSqlAttempt', () => {
    const okConn = {
      validate: sinon.stub().resolves(),
    } as unknown as IDbConnector;
    it('passes when generation + both validators succeed', async () => {
      const r = await runSqlAttempt({
        chatLlm: model('SELECT * FROM employees;'),
        dbConnector: okConn,
        prompt: 'all employees',
        tables: ['employees'],
        checklist: undefined,
        buildPrompt: buildGenerateSqlPrompt,
      });
      expect(r.passed).to.be.true();
      expect(r.sql).to.equal('SELECT * FROM employees;');
    });
    it('fails (with feedback) when generation errors', async () => {
      const r = await runSqlAttempt({
        chatLlm: throwingModel(),
        dbConnector: okConn,
        prompt: 'x',
        tables: ['t'],
        buildPrompt: buildGenerateSqlPrompt,
      });
      expect(r.passed).to.be.false();
      expect(r.feedback).to.match(/LLM down/);
    });
    it('on the last attempt accepts syntactically-valid SQL even if the semantic judge rejects', async () => {
      const r = await runSqlAttempt({
        chatLlm: model('<invalid>nitpick</invalid>'), // judge rejects, but gen text is also this — sql is non-empty
        dbConnector: okConn,
        prompt: 'q',
        tables: ['t'],
        checklist: '- a',
        buildPrompt: buildGenerateSqlPrompt,
        lastAttempt: true,
      });
      // syntactic passed (okConn) + lastAttempt => accept, never empty
      expect(r.passed).to.be.true();
    });
  });

  describe('pickRelevantTables (get-columns)', () => {
    const args = {
      prompt: 'names',
      tablesWithColumns: {employees: ['id', 'name', 'salary']},
      upstreamTables: ['employees'],
    };
    it('returns the filtered table list from valid JSON', async () => {
      const r = await pickRelevantTables({
        ...args,
        chatLlm: model('```json\n{"employees":["id","name"]}\n```'),
      });
      expect(r).to.eql(['employees']);
    });
    it('returns null on unparseable JSON', async () => {
      const r = await pickRelevantTables({...args, chatLlm: model('not json')});
      expect(r).to.be.null();
    });
    it('returns null when no schema columns are available', async () => {
      const r = await pickRelevantTables({
        prompt: 'x',
        tablesWithColumns: {},
        upstreamTables: [],
        chatLlm: model('{}'),
      });
      expect(r).to.be.null();
    });
  });

  describe('resolvePersistDeps (save-dataset prerequisites)', () => {
    const store = {} as never;
    it('returns null when the store is missing', () => {
      expect(
        resolvePersistDeps(undefined, {tenantId: 't'} as never),
      ).to.be.null();
    });
    it('returns null when the user has no tenantId', () => {
      expect(resolvePersistDeps(store, {} as never)).to.be.null();
    });
    it('returns store + user when both are present', () => {
      const r = resolvePersistDeps(store, {tenantId: 't'} as never);
      expect(r).to.not.be.null();
      expect(r?.user.tenantId).to.equal('t');
    });
  });
});

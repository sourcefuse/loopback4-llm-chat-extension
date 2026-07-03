import {expect, sinon} from '@loopback/testlab';
import {createMockModel} from '@mastra/core/test-utils/llm-mock';
import type {LanguageModel} from 'ai';
import type {IDbConnector} from '../../../components/db-query/types';
import {
  buildGenerateSqlPrompt,
  buildImproveSqlPrompt,
  generateSqlOnce,
  idToString,
  pickRelevantTables,
  resolvePersistDeps,
  runSqlAttempt,
  stripJsonFences,
  stripSqlFences,
} from '../../../components/db-query/steps/_helpers';
import {shouldUseCheapForSqlGen} from '../../../components/db-query/steps/sql-and-validate.step';
import {SqlValidatorService} from '../../../components/db-query/services/sql-validator.service';
import {PermissionHelper} from '../../../components/db-query/services/permission-helper.service';
import {TemplateHelper} from '../../../components/db-query/services/template-helper.service';
import {SchemaStore} from '../../../components/db-query/services/schema.store';
import {DataSetHelper} from '../../../components/db-query/services/dataset-helper.service';
import {DatasetActionType} from '../../../components/db-query/constant';
import {
  checkCacheStep,
  generateChecklistStep,
} from '../../../components/db-query/workflows/generate.workflow';
import {STEP_GET_COLUMNS} from '../../../components/db-query/steps/constants';
import {GetTablesStep} from '../../../components/db-query/steps/get-tables.step';
import {makeContainerStepResolver} from '../../fixtures/step-resolver';

// The syntactic/semantic/classify validators moved to SqlValidatorService
// (v2 parity); it is stateless, so one shared instance drives these tests.
const sqlValidator = new SqlValidatorService();

/**
 * Minimal RequestContext stand-in: workflow steps only call `.get(key)`. Always
 * carries `resolveStep` (the static resolver) so a step-shell `.execute()`
 * resolves its `@step` class, which then reads the rest of the map. A test may
 * override `resolveStep` via the map.
 */
function fakeRc(map: Record<string, unknown>): never {
  // Converted steps read collaborators + model tiers via constructor DI, so
  // route the map's stubs through the container resolver; the fake rc only
  // needs `resolveStep` + `eventWriter` (the step shells read those from rc).
  const {resolver} = makeContainerStepResolver({
    queryCache: map.queryCache,
    templateCache: map.templateCache,
    datasetStore: map.datasetStore,
    dataSetHelper: map.dataSetHelper,
    schemaStore: map.schemaStore,
    schemaHelper: map.schemaHelper,
    permissionHelper: map.permissionHelper,
    templateStore: map.templateStore,
    config: map.config,
    chatModel: map.chatLlm,
    cheapModel: map.cheapLlm,
    smartModel: map.smartLlm,
  });
  const full: Record<string, unknown> = {
    resolveStep: map.resolveStep ?? resolver,
    ...map,
  };
  return {get: (k: string) => full[k]} as never;
}
/** Invoke a Mastra step's execute directly with a fake context. */
async function runStep(
  step: {execute: (args: never) => Promise<unknown>},
  inputData: unknown,
  rc: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await step.execute({
    inputData,
    requestContext: fakeRc(rc),
    tracingContext: undefined,
    getStepResult: () => undefined,
    getInitData: () => undefined,
  } as never)) as Record<string, unknown>;
}

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
    it('embeds a Similar-cache worked example when sampleSql is supplied', () => {
      const p = buildGenerateSqlPrompt({
        prompt: 'top earners',
        tables: ['employees'],
        sampleSql: 'SELECT name FROM employees ORDER BY salary DESC',
        samplePrompt: 'highest paid staff',
      });
      expect(p).to.match(/<similar-example-query>/);
      expect(p).to.match(/ORDER BY salary DESC/);
      expect(p).to.match(/highest paid staff/);
    });
    it('omits the example block when no sampleSql is supplied', () => {
      const p = buildGenerateSqlPrompt({prompt: 'x', tables: ['t']});
      expect(p).to.not.match(/similar-example-query/);
    });
  });

  describe('buildImproveSqlPrompt (fix-query)', () => {
    it('includes the existing SQL, the delta request and feedback', () => {
      const p = buildImproveSqlPrompt({
        prompt: 'also show currency',
        tables: ['employees', 'currencies'],
        originalSql: 'SELECT name FROM employees',
        feedback: 'add the join',
      });
      expect(p).to.match(/SELECT name FROM employees/);
      expect(p).to.match(/also show currency/);
      expect(p).to.match(/add the join/);
    });

    it('embeds the validation checklist when provided (v2 fix-query parity)', () => {
      const p = buildImproveSqlPrompt({
        prompt: 'p',
        tables: ['employees'],
        originalSql: 'SELECT 1',
        checklist: 'Must filter by active = true',
      });
      expect(p).to.match(/Validation checklist:/);
      expect(p).to.match(/Must filter by active = true/);
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
      expect(await sqlValidator.validateSyntactic('SELECT 1', conn)).to.eql({
        passed: true,
      });
    });
    it('fails with feedback when the connector rejects', async () => {
      const conn = {
        validate: sinon.stub().rejects(new Error('near ")": syntax error')),
      } as unknown as IDbConnector;
      const r = await sqlValidator.validateSyntactic('SELECT (', conn);
      expect(r.passed).to.be.false();
      expect(r.feedback).to.match(/syntax error/);
    });
    it('is a no-op pass when no connector is bound', async () => {
      expect(
        await sqlValidator.validateSyntactic('SELECT 1', undefined),
      ).to.eql({
        passed: true,
      });
    });
  });

  describe('validateSqlSemantic', () => {
    const base = {sql: 'SELECT 1', prompt: 'q', checklist: '- a'};
    it('passes on a <valid/> verdict', async () => {
      const r = await sqlValidator.validateSemantic({
        ...base,
        chatLlm: model('<valid/>'),
      });
      expect(r.passed).to.be.true();
    });
    it('fails on an <invalid> verdict and surfaces the reason', async () => {
      const r = await sqlValidator.validateSemantic({
        ...base,
        chatLlm: model('<invalid>missing the active-rate filter</invalid>'),
      });
      expect(r.passed).to.be.false();
      expect(r.feedback).to.match(/active-rate filter/);
    });
    it('defaults to PASS when the judge returns neither tag (lenient)', async () => {
      const r = await sqlValidator.validateSemantic({
        ...base,
        chatLlm: model('looks fine to me'),
      });
      expect(r.passed).to.be.true();
    });
    it('passes (skips) when no checklist is supplied', async () => {
      const r = await sqlValidator.validateSemantic({
        sql: 'SELECT 1',
        prompt: 'q',
        chatLlm: model('<invalid>x</invalid>'),
      });
      expect(r.passed).to.be.true();
    });
    it('passes when the judge errors (advisory only)', async () => {
      const r = await sqlValidator.validateSemantic({
        ...base,
        chatLlm: throwingModel(),
      });
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

    it('streams the description as thinkingToken events when descriptionLlm + rc are set', async () => {
      const events: Array<{type: string; data: {thinkingToken?: string}}> = [];
      const rc = {
        get: (k: string) =>
          k === 'eventWriter'
            ? (e: {type: string; data: {thinkingToken?: string}}) =>
                events.push(e)
            : undefined,
      } as never;
      const r = await runSqlAttempt({
        chatLlm: model('SELECT name FROM employees;'),
        dbConnector: okConn,
        prompt: 'list employees',
        tables: ['employees'],
        buildPrompt: buildGenerateSqlPrompt,
        descriptionLlm: model('Lists the names of all employees.'),
        rc,
      });
      expect(r.passed).to.be.true();
      // At least one thinkingToken event streamed, and the accumulated
      // description came back (not the static fallback).
      const thinking = events.filter(e => e.data.thinkingToken !== undefined);
      expect(thinking.length).to.be.greaterThan(0);
      expect(r.description ?? '').to.match(/employees/i);
    });

    it('emits NO thinkingToken and uses the static description when descriptionLlm is omitted', async () => {
      const events: Array<{data: {thinkingToken?: string}}> = [];
      const rc = {
        get: (k: string) =>
          k === 'eventWriter'
            ? (e: {data: {thinkingToken?: string}}) => events.push(e)
            : undefined,
      } as never;
      const r = await runSqlAttempt({
        chatLlm: model('SELECT 1;'),
        dbConnector: okConn,
        prompt: 'q',
        tables: ['t'],
        buildPrompt: buildGenerateSqlPrompt,
        buildDescription: (_sql, p) => `Generated SQL for: ${p}`,
        rc,
        // descriptionLlm intentionally omitted → streaming disabled
      });
      expect(
        events.some(e => e.data.thinkingToken !== undefined),
      ).to.be.false();
      expect(r.description).to.equal('Generated SQL for: q');
    });
  });

  describe('classifySqlError (v2 SyntacticValidatorNode reclassification)', () => {
    const allTables = ['employees', 'departments', 'currencies'];
    it('parses a table_not_found verdict and its related tables', async () => {
      const r = await sqlValidator.classifyError({
        chatLlm: model(
          '<category>table_not_found</category><tables>departments, employees</tables>',
        ),
        error: 'no such table: departments',
        sql: 'SELECT * FROM departments',
        allTables,
      });
      expect(r.category).to.equal('table_not_found');
      expect(r.errorTables).to.eql(['departments', 'employees']);
    });
    it('treats any non-table verdict as query_error', async () => {
      const r = await sqlValidator.classifyError({
        chatLlm: model('<category>query_error</category><tables></tables>'),
        error: 'syntax error near )',
        sql: 'SELECT (',
        allTables,
      });
      expect(r.category).to.equal('query_error');
      expect(r.errorTables).to.eql([]);
    });
    it('defaults to query_error/[] when the verdict is unparseable', async () => {
      const r = await sqlValidator.classifyError({
        chatLlm: model('I have no idea'),
        error: 'boom',
        sql: 'SELECT 1',
        allTables,
      });
      expect(r).to.eql({category: 'query_error', errorTables: []});
    });
    it('defaults to query_error/[] when no LLM is bound', async () => {
      const r = await sqlValidator.classifyError({
        chatLlm: undefined,
        error: 'boom',
        sql: 'SELECT 1',
        allTables,
      });
      expect(r).to.eql({category: 'query_error', errorTables: []});
    });
    it('defaults to query_error/[] when the schema table list is empty', async () => {
      const r = await sqlValidator.classifyError({
        chatLlm: model(
          '<category>table_not_found</category><tables>x</tables>',
        ),
        error: 'boom',
        sql: 'SELECT 1',
        allTables: [],
      });
      expect(r).to.eql({category: 'query_error', errorTables: []});
    });
    it('defaults to query_error/[] when the classifier model throws', async () => {
      const r = await sqlValidator.classifyError({
        chatLlm: throwingModel(),
        error: 'boom',
        sql: 'SELECT 1',
        allTables,
      });
      expect(r).to.eql({category: 'query_error', errorTables: []});
    });
  });

  describe('runSqlAttempt table_not_found expansion (v2 ReselectTables)', () => {
    const rejectingConn = {
      validate: sinon.stub().rejects(new Error('no such table: departments')),
    } as unknown as IDbConnector;
    const okConn = {
      validate: sinon.stub().resolves(),
    } as unknown as IDbConnector;

    it('widens the allowed table set when a syntactic failure is table_not_found', async () => {
      let reselected: string[] | undefined;
      const r = await runSqlAttempt({
        chatLlm: model('SELECT * FROM departments'),
        // separate model for the classifier call (args.cheapLlm ?? chatLlm)
        cheapLlm: model(
          '<category>table_not_found</category><tables>departments</tables>',
        ),
        allTables: ['employees', 'departments'],
        dbConnector: rejectingConn,
        prompt: 'employees and their departments',
        tables: ['employees'],
        buildPrompt: buildGenerateSqlPrompt,
        onReselectTables: t => (reselected = t),
      });
      expect(r.passed).to.be.false();
      expect(r.tables).to.eql(['employees', 'departments']);
      expect(reselected).to.eql(['employees', 'departments']);
    });

    it('does not expand on a query_error verdict', async () => {
      const r = await runSqlAttempt({
        chatLlm: model('SELECT ('),
        cheapLlm: model('<category>query_error</category><tables></tables>'),
        allTables: ['employees', 'departments'],
        dbConnector: rejectingConn,
        prompt: 'x',
        tables: ['employees'],
        buildPrompt: buildGenerateSqlPrompt,
      });
      expect(r.tables).to.be.undefined();
    });

    it('ignores classifier tables that are not in the real schema', async () => {
      const r = await runSqlAttempt({
        chatLlm: model('SELECT * FROM ghosts'),
        cheapLlm: model(
          '<category>table_not_found</category><tables>ghosts</tables>',
        ),
        allTables: ['employees', 'departments'],
        dbConnector: rejectingConn,
        prompt: 'x',
        tables: ['employees'],
        buildPrompt: buildGenerateSqlPrompt,
      });
      // 'ghosts' filtered out → nothing new to add → no expansion
      expect(r.tables).to.be.undefined();
    });

    it('does not classify or expand when validation passes', async () => {
      const r = await runSqlAttempt({
        chatLlm: model('SELECT * FROM employees'),
        cheapLlm: model(
          '<category>table_not_found</category><tables>x</tables>',
        ),
        allTables: ['employees', 'departments'],
        dbConnector: okConn,
        prompt: 'x',
        tables: ['employees'],
        buildPrompt: buildGenerateSqlPrompt,
      });
      expect(r.passed).to.be.true();
      expect(r.tables).to.be.undefined();
    });

    it('skips expansion entirely when allTables is not supplied', async () => {
      const r = await runSqlAttempt({
        chatLlm: model('SELECT * FROM departments'),
        cheapLlm: model(
          '<category>table_not_found</category><tables>departments</tables>',
        ),
        dbConnector: rejectingConn,
        prompt: 'x',
        tables: ['employees'],
        buildPrompt: buildGenerateSqlPrompt,
      });
      expect(r.tables).to.be.undefined();
    });
  });

  describe('SchemaStore.allTableNames', () => {
    // Exercise the real method against a stub `get` via the prototype.
    const allTableNames = SchemaStore.prototype.allTableNames;
    it('returns the schema table names', () => {
      const store = {
        get: () => ({tables: {employees: {}, departments: {}}}),
      };
      expect(allTableNames.call(store as never)).to.eql([
        'employees',
        'departments',
      ]);
    });
    it('returns [] at the call site when the SchemaStore is unbound', () => {
      const namesOf = (s: SchemaStore | undefined) => s?.allTableNames() ?? [];
      expect(namesOf(undefined)).to.eql([]);
    });
    it('returns [] when the schema is not yet loaded', () => {
      const store = {
        get: () => {
          throw new Error('not loaded');
        },
      };
      expect(allTableNames.call(store as never)).to.eql([]);
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
      expect(r).to.eql({kind: 'tables', tables: ['employees']});
    });
    it('returns unanswerable + reason when the LLM signals no table fits', async () => {
      const r = await pickRelevantTables({
        ...args,
        chatLlm: model(
          '{"__unanswerable__":"No salary information is stored for employees."}',
        ),
      });
      expect(r).to.eql({
        kind: 'unanswerable',
        reason: 'No salary information is stored for employees.',
      });
    });
    it('returns unknown on unparseable JSON (LLM hiccup, not a verdict)', async () => {
      const r = await pickRelevantTables({...args, chatLlm: model('not json')});
      expect(r).to.eql({kind: 'unknown'});
    });
    it('returns unknown when the picked tables do not overlap the upstream set', async () => {
      const r = await pickRelevantTables({
        ...args,
        chatLlm: model('{"some_other_table":["x"]}'),
      });
      expect(r).to.eql({kind: 'unknown'});
    });
    it('returns unknown when no schema columns are available', async () => {
      const r = await pickRelevantTables({
        prompt: 'x',
        tablesWithColumns: {},
        upstreamTables: [],
        chatLlm: model('{}'),
      });
      expect(r).to.eql({kind: 'unknown'});
    });
  });

  describe('generateChecklistStep (checklist gate)', () => {
    const threeTables = ['employees', 'currency', 'exchange_rate'];
    // generateChecklistStep receives Mastra's branch-wrapped envelope:
    // { [stepId]: BranchResult }. Wrap helpers mirror the runtime shape.
    const continueInput = (prompt: string, tables: string[]) => ({
      [STEP_GET_COLUMNS]: {kind: 'continue' as const, prompt, tables},
    });

    it('runs the checklist LLM for multi-table queries when enabled', async () => {
      const out = await runStep(
        generateChecklistStep,
        continueInput('salaries by currency', threeTables),
        {chatLlm: model('- only active rows')},
      );
      expect(out.checklist).to.equal('- only active rows');
    });

    it('skips the checklist LLM when the consumer disabled the node', async () => {
      const out = await runStep(
        generateChecklistStep,
        continueInput('salaries by currency', threeTables),
        {
          chatLlm: model('- this must be ignored'),
          config: {nodes: {generateChecklistNode: {enabled: false}}},
        },
      );
      // Gated → empty checklist, model output never consulted.
      expect(out.checklist).to.equal('');
    });

    it('skips the checklist LLM on <=2 tables (no join to mis-plan)', async () => {
      const out = await runStep(
        generateChecklistStep,
        continueInput('list employees', ['employees', 'currency']),
        {chatLlm: model('- this must be ignored')},
      );
      expect(out.checklist).to.equal('');
    });
  });

  describe('DataSetHelper.isCachedDatasetUsable (dislike filtering)', () => {
    // Exercise the real method against a `{store}` context via the prototype.
    const isUsable = DataSetHelper.prototype.isCachedDatasetUsable;
    const ctx = (actions?: {action: DatasetActionType}[]) =>
      ({
        store: {
          findById: async () => ({id: 'd1', query: 'SELECT 1', actions}),
        },
      }) as never;

    it('usable when the dataset has no actions', async () => {
      expect(await isUsable.call(ctx(), 'd1')).to.be.true();
    });
    it('usable when only liked', async () => {
      const r = await isUsable.call(
        ctx([{action: DatasetActionType.Liked}]),
        'd1',
      );
      expect(r).to.be.true();
    });
    it('NOT usable when disliked (must regenerate)', async () => {
      const r = await isUsable.call(
        ctx([{action: DatasetActionType.Disliked}]),
        'd1',
      );
      expect(r).to.be.false();
    });
    it('NOT usable when the dataset lookup throws (missing)', async () => {
      const context = {
        store: {
          findById: async () => {
            throw new Error('not found');
          },
        },
      } as never;
      expect(await isUsable.call(context, 'd1')).to.be.false();
    });
  });

  describe('DataSetHelper.loadSampleQuery (Similar-cache example seed)', () => {
    const loadSample = DataSetHelper.prototype.loadSampleQuery;
    const ctx = (query: string, actions: unknown[] = []) =>
      ({
        store: {findById: async () => ({id: 'd1', query, actions})},
      }) as never;

    it('returns the query + prompt for a usable dataset', async () => {
      const r = await loadSample.call(ctx('SELECT 1'), 'd1', 'how many');
      expect(r).to.eql({sampleSql: 'SELECT 1', samplePrompt: 'how many'});
    });
    it('returns undefined for a disliked dataset (poor example)', async () => {
      const r = await loadSample.call(
        ctx('SELECT 1', [{action: DatasetActionType.Disliked}]),
        'd1',
        'q',
      );
      expect(r).to.be.undefined();
    });
    it('returns undefined when the query is empty', async () => {
      expect(await loadSample.call(ctx(''), 'd1', 'q')).to.be.undefined();
    });
    it('returns undefined at the call site when no DataSetHelper is bound', () => {
      const seed = (h: DataSetHelper | undefined) =>
        h?.loadSampleQuery('d1', 'q');
      expect(seed(undefined)).to.be.undefined();
    });
  });

  describe('PermissionHelper.filterAuthorizedTables (get-tables + reselect guard)', () => {
    // Exercise the real method against a stub `findMissingPermissions` via the
    // prototype (avoids constructing PermissionHelper's config/user injections).
    const filterAuthorized = PermissionHelper.prototype.filterAuthorizedTables;
    const helper = {
      findMissingPermissions: (t: string[]) =>
        t[0] === 'salaries' ? ['view_salaries'] : [],
    };

    it('drops tables the user lacks permission for', () => {
      expect(
        filterAuthorized.call(helper as never, ['employees', 'salaries']),
      ).to.eql(['employees']);
    });

    it('strips the schema prefix before the lookup', () => {
      const seen: string[][] = [];
      const spy = {
        findMissingPermissions: (t: string[]) => {
          seen.push(t);
          return [];
        },
      };
      filterAuthorized.call(spy as never, ['main.employees']);
      expect(seen).to.eql([['employees']]);
    });

    it('fails open at the call site when no PermissionHelper is bound', () => {
      // Callers use `permissionHelper?.filterAuthorizedTables(x) ?? x`.
      const applyFilter = (ph: PermissionHelper | undefined, t: string[]) =>
        ph?.filterAuthorizedTables(t) ?? t;
      expect(applyFilter(undefined, ['a', 'b'])).to.eql(['a', 'b']);
    });
  });

  describe('TemplateHelper.resolveById (template SQL + authoritative tables)', () => {
    // Exercise the real method against a stub `resolveTemplate` via the
    // prototype (resolveById delegates to `this.resolveTemplate`).
    const resolveById = TemplateHelper.prototype.resolveById;
    const templateStore = {
      findById: async () => ({
        id: 'tmpl-1',
        tables: ['employees', 'salaries'],
        template: 'SELECT * FROM salaries',
      }),
    } as never;

    it('returns the resolved SQL together with the template tables', async () => {
      const helper = {
        resolveTemplate: async () => ({
          sql: 'SELECT * FROM salaries',
          description: 'salary report',
        }),
      };

      const r = await resolveById.call(helper as never, {
        templateStore,
        schemaStore: undefined,
        templateId: 'tmpl-1',
        prompt: 'salaries',
      });

      // tables come from the template, NOT the get-tables guess — this is what
      // lets the read-time ACL gate on every table the template SQL reads.
      expect(r).to.eql({
        sql: 'SELECT * FROM salaries',
        description: 'salary report',
        tables: ['employees', 'salaries'],
      });
    });

    it('returns null when the template resolves to empty SQL', async () => {
      const helper = {
        resolveTemplate: async () => ({sql: '', description: ''}),
      };
      const r = await resolveById.call(helper as never, {
        templateStore,
        schemaStore: undefined,
        templateId: 'tmpl-1',
        prompt: 'x',
      });
      expect(r).to.be.null();
    });

    it('returns null when the template store is unbound', async () => {
      const helper = {
        resolveTemplate: async () => ({sql: 'x', description: ''}),
      };
      expect(
        await resolveById.call(helper as never, {
          templateStore: undefined,
          schemaStore: undefined,
          templateId: 'tmpl-1',
          prompt: 'x',
        }),
      ).to.be.null();
    });
  });

  describe('shouldUseCheapForSqlGen (tier selection)', () => {
    it('cheap on a validation-fix retry regardless of table count', () => {
      expect(shouldUseCheapForSqlGen(undefined, 5, 1)).to.be.true();
    });
    it('cheap on a single-table first attempt', () => {
      expect(shouldUseCheapForSqlGen(undefined, 1, 0)).to.be.true();
    });
    it('smart on a multi-table first attempt', () => {
      expect(shouldUseCheapForSqlGen(undefined, 3, 0)).to.be.false();
    });
    it('smart for single-table when the consumer forces it', () => {
      const config = {
        nodes: {sqlGenerationNode: {useSmartLLMForSingleTableQueries: true}},
      } as never;
      expect(shouldUseCheapForSqlGen(config, 1, 0)).to.be.false();
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

  // get-tables is now the DI-backed GetTablesStep class (resolved by the
  // workflow shell at run time). The baseline behaviour is asserted by
  // constructing the class with a stub SchemaStore — the shell/resolver wiring
  // is covered in the workflow + integration suites.
  describe('GetTablesStep (get-tables baseline)', () => {
    it('returns the schema table names from SchemaStore', async () => {
      // SchemaStore is now constructor-injected — pass it to the class, not rc.
      const step = new GetTablesStep({
        get: () => ({tables: {employees: {}, currencies: {}}}),
      } as never);
      const out = await runStep(step, {prompt: 'x'}, {});
      expect(out.tables).to.eql(['employees', 'currencies']);
    });
    it('returns [] when no SchemaStore is bound', async () => {
      const out = await runStep(new GetTablesStep(), {prompt: 'x'}, {});
      expect(out.tables).to.eql([]);
    });
  });

  describe('checkCacheStep (cache judge)', () => {
    const cache = (docs: unknown[]) => ({invoke: async () => docs});
    it('returns cacheHit when the judge replies AsIs <index>', async () => {
      const out = await runStep(
        checkCacheStep,
        {prompt: 'top earners'},
        {
          queryCache: cache([
            {pageContent: 'highest paid', metadata: {id: '42'}},
          ]),
          cheapLlm: model('AsIs 1'),
        },
      );
      expect(out.cacheHit).to.be.true();
      expect(out.datasetId).to.equal('42');
    });
    it('returns no cacheHit when the judge replies Similar', async () => {
      const out = await runStep(
        checkCacheStep,
        {prompt: 'top earners'},
        {
          queryCache: cache([
            {pageContent: 'highest paid', metadata: {id: '42'}},
          ]),
          cheapLlm: model('Similar 1'),
        },
      );
      expect(out.cacheHit).to.be.false();
    });
    it('returns no cacheHit when the cache has no candidates', async () => {
      const out = await runStep(
        checkCacheStep,
        {prompt: 'x'},
        {queryCache: cache([]), cheapLlm: model('AsIs 1')},
      );
      expect(out.cacheHit).to.be.false();
    });
  });
});

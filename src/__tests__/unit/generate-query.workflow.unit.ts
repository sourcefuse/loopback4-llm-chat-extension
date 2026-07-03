import {expect, sinon} from '@loopback/testlab';
import {RequestContext} from '@mastra/core/request-context';
import * as helpers from '../../components/db-query/steps/_helpers';
import {generateQueryWorkflow} from '../../components/db-query/workflows/generate.workflow';
import {MAX_VALIDATION_ATTEMPTS} from '../../components/db-query/steps/constants';
import type {MastraRcShape} from '../../components/db-query/steps/_helpers';
import {DatasetActionType} from '../../components/db-query/constant';
import {makeContainerStepResolver} from '../fixtures/step-resolver';

/**
 * DAG-level coverage for `generateQueryWorkflow`. The integration test
 * in src/__tests__/integration/generate-workflow.integration.ts already
 * exercises the happy `Continue → SQL gen → validate → save` path with
 * a mocked smart model. These tests cover the THREE other branch arms:
 *
 *   1) AsIs              — cache judge says "this past query answers it"
 *   2) FromTemplate      — template judge says "match"
 *   3) Failed (Continue) — every SQL attempt fails → MAX_VALIDATION_ATTEMPTS
 *                          → failedStep terminal
 *
 * Each test stubs the LLM helpers at `_helpers` (single CommonJS exports
 * object — sinon replaces the export the steps actually call), so we
 * avoid wiring real models and exercise pure routing.
 */
describe('generateQueryWorkflow (DAG branching, unit)', () => {
  afterEach(() => sinon.restore());

  type GenOut = {datasetId: string; sql: string};

  function makeRc(
    overrides: Partial<MastraRcShape> & {sqlGenHelper?: unknown} = {},
  ): RequestContext<MastraRcShape> {
    const rc = new RequestContext<MastraRcShape>();
    rc.set('resourceId', overrides.resourceId ?? 't1:u1');
    rc.set('eventWriter', overrides.eventWriter ?? (() => undefined));
    // Steps read collaborators + resolved model tiers via constructor DI, so
    // route the stubs through the container resolver. A mock chatModel is
    // always provided so the (stubbed) `tracedGenerateText` boundary is
    // reachable (the cheap/smart tiers fall back to it). The shell reads
    // `resolveStep` + `eventWriter` from this rc.
    const {resolver} = makeContainerStepResolver({
      chatModel: {modelId: 'mock'},
      queryCache: overrides.queryCache,
      templateCache: overrides.templateCache,
      schemaStore: overrides.schemaStore,
      schemaHelper: overrides.schemaHelper,
      datasetStore: overrides.datasetStore,
      templateStore: overrides.templateStore,
      templateHelper: overrides.templateHelper,
      connector: overrides.dbConnector,
      authUser: overrides.authUser,
      sqlGenHelper: overrides.sqlGenHelper,
    });
    rc.set('resolveStep', resolver);
    return rc;
  }

  // Stub `tracedGenerateText` with label-based dispatch — each step
  // passes a distinct `label` so we can route to the right canned text.
  function stubLlm(byLabel: Record<string, string>): sinon.SinonStub {
    return sinon
      .stub(helpers, 'tracedGenerateText')
      .callsFake(async (args: {label?: string}) => {
        const text = (args.label && byLabel[args.label]) ?? '';
        return {text} as Awaited<ReturnType<typeof helpers.tracedGenerateText>>;
      });
  }

  // ──────────────────────────────────────────────────────────
  // AsIs path: cache hit → returnCachedStep terminal
  // ──────────────────────────────────────────────────────────

  it('AsIs branch — cache hit short-circuits to returnCachedStep and the workflow exits with the cached datasetId', async () => {
    stubLlm({'cache-judge': 'AsIs 1'});
    const queryCache = {
      invoke: sinon
        .stub()
        .resolves([
          {pageContent: 'list employees', metadata: {id: 'ds-cached'}},
        ]),
    };
    const templateCache = {invoke: sinon.stub().resolves([])};
    const findById = sinon
      .stub()
      .resolves({id: 'ds-cached', query: 'SELECT * FROM employees'});
    const datasetCreate = sinon.stub();

    const rc = makeRc({
      queryCache,
      templateCache,
      datasetStore: {findById, create: datasetCreate} as never,
      authUser: {id: 'u1', tenantId: 't1'} as never,
    });

    const run = await generateQueryWorkflow.createRun();
    const result = await run.start({
      inputData: {prompt: 'list employees'},
      requestContext: rc as RequestContext,
    });

    expect(result.status).to.equal('success');
    if (result.status !== 'success') return;
    // The terminal branch wraps the payload under the matched arm's id
    // (`save-dataset` or `failed`) — mirror that unwrap in the assertion.
    const wrapped = result.result as Record<string, unknown>;
    const out =
      (wrapped['save-dataset'] as GenOut) ?? (wrapped as unknown as GenOut);
    // The save-dataset branch arm preserves the cached datasetId via
    // the `cached:true` short-circuit in saveDatasetStep.
    expect(out.datasetId).to.equal('ds-cached');
    expect(out.sql).to.equal('SELECT * FROM employees');
    // Confirm we never went through the SQL-gen → persist pipeline.
    sinon.assert.notCalled(datasetCreate);
  });

  // ──────────────────────────────────────────────────────────
  // AsIs cache hit, but the cached dataset was DISLIKED → must
  // regenerate, not re-serve (restored v2 CheckCacheNode filter).
  // ──────────────────────────────────────────────────────────

  it('AsIs cache hit but the dataset was disliked → regenerates instead of re-serving', async () => {
    stubLlm({
      'cache-judge': 'AsIs 1',
      'template-judge': 'no_match',
      'generate-checklist': '',
    });
    sinon.stub(helpers, 'pickRelevantTables').resolves({kind: 'unknown'});
    const runAttempt = sinon.stub().resolves({
      sql: 'SELECT regenerated',
      passed: true,
      description: 'd',
    });
    const schema = {tables: {employees: {columns: {id: {}}}}};
    const queryCache = {
      invoke: sinon
        .stub()
        .resolves([
          {pageContent: 'list employees', metadata: {id: 'ds-cached'}},
        ]),
    };
    const templateCache = {invoke: sinon.stub().resolves([])};
    // The cached dataset carries a Disliked action.
    const findById = sinon.stub().resolves({
      id: 'ds-cached',
      query: 'SELECT old',
      actions: [{action: DatasetActionType.Disliked}],
    });
    const create = sinon.stub().resolves({id: 'ds-new'});

    const rc = makeRc({
      queryCache,
      templateCache,
      schemaStore: {get: () => schema, filteredSchema: () => schema} as never,
      datasetStore: {findById, create} as never,
      authUser: {id: 'u1', tenantId: 't1'} as never,
      dbConnector: {
        validate: async () => undefined,
        execute: async () => [],
      } as never,
      sqlGenHelper: {runAttempt},
    });

    const run = await generateQueryWorkflow.createRun();
    const result = await run.start({
      inputData: {prompt: 'list employees'},
      requestContext: rc as RequestContext,
    });

    expect(result.status).to.equal('success');
    if (result.status !== 'success') return;
    // Regenerated: SQL-gen ran and a NEW dataset was created — the disliked
    // cached row was NOT re-served.
    sinon.assert.called(runAttempt);
    sinon.assert.calledOnce(create);
    const wrapped = result.result as Record<string, unknown>;
    const out =
      (wrapped['save-dataset'] as GenOut) ?? (wrapped as unknown as GenOut);
    expect(out.datasetId).to.equal('ds-new');
  });

  // ──────────────────────────────────────────────────────────
  // FromTemplate path: template match → saveDatasetFromTemplateStep
  // ──────────────────────────────────────────────────────────

  it('FromTemplate branch — template judge match routes to saveDatasetFromTemplateStep and persists the resolved SQL', async () => {
    // cache judge: NotRelevant so cache misses
    // templates judge: "match 1" so template-id is taken
    stubLlm({'cache-judge': 'NotRelevant', 'template-judge': 'match 1'});
    // resolveTemplateById moved onto TemplateHelper.resolveById — the step now
    // resolves the template through the injected helper.
    const templateHelper = {
      resolveById: sinon.stub().resolves({
        sql: 'SELECT 1 FROM tmpl',
        description: 'from template',
        tables: ['tmpl_table'],
      }),
    } as never;
    sinon.stub(helpers, 'computeSchemaHash').returns({
      schemaHash: 'abc',
      tablesFromSchema: ['employees'],
    });

    const queryCache = {invoke: sinon.stub().resolves([])};
    const templateCache = {
      invoke: sinon
        .stub()
        .resolves([{pageContent: 'tmpl', metadata: {id: 'tmpl-1'}}]),
    };
    const create = sinon.stub().resolves({id: 999});
    const findById = sinon
      .stub()
      .resolves({id: 999, query: 'SELECT 1 FROM tmpl'});

    const rc = makeRc({
      queryCache,
      templateCache,
      templateHelper,
      datasetStore: {create, findById} as never,
      authUser: {id: 'u1', tenantId: 't1'} as never,
      schemaStore: {get: () => ({tables: {employees: {}}})} as never,
    });

    const run = await generateQueryWorkflow.createRun();
    const result = await run.start({
      inputData: {prompt: 'list employees'},
      requestContext: rc as RequestContext,
    });

    expect(result.status).to.equal('success');
    if (result.status !== 'success') return;
    const wrapped = result.result as Record<string, unknown>;
    const out =
      (wrapped['save-dataset'] as GenOut) ?? (wrapped as unknown as GenOut);
    // Template path created a fresh dataset row; id is coerced to string.
    expect(out.datasetId).to.equal('999');
    expect(out.sql).to.equal('SELECT 1 FROM tmpl');
    sinon.assert.calledOnce(create);
    const persisted = create.firstCall.args[0] as Record<string, unknown>;
    expect(persisted.query).to.equal('SELECT 1 FROM tmpl');
    expect(persisted.tenantId).to.equal('t1');
    // Tier 1: the template's authoritative table is persisted on the dataset
    // so the read-time ACL (DataSetHelper.getDataFromDataset) gates on it.
    expect(persisted.tables as string[]).to.containEql('tmpl_table');
  });

  // ──────────────────────────────────────────────────────────
  // Continue path that fails every attempt → failedStep terminal
  // ──────────────────────────────────────────────────────────

  it(`Continue branch — when every SQL attempt fails the dountil exits after ${MAX_VALIDATION_ATTEMPTS} attempts and failedStep produces the empty sentinel`, async () => {
    // cache: miss, templates: no match → Continue branch
    stubLlm({
      'cache-judge': 'NotRelevant',
      'template-judge': 'no_match',
      'generate-checklist': '',
    });
    const runAttempt = sinon.stub().resolves({
      sql: 'BROKEN',
      passed: false,
      feedback: 'syntactic error',
    });

    const queryCache = {invoke: sinon.stub().resolves([])};
    const templateCache = {invoke: sinon.stub().resolves([])};
    const datasetCreate = sinon.stub();

    const rc = makeRc({
      queryCache,
      templateCache,
      schemaStore: {
        get: () => ({tables: {employees: {columns: {id: {}}}}}),
      } as never,
      datasetStore: {create: datasetCreate, findById: sinon.stub()} as never,
      authUser: {id: 'u1', tenantId: 't1'} as never,
      dbConnector: {
        validate: async () => undefined,
        execute: async () => [],
      } as never,
      sqlGenHelper: {runAttempt},
    });

    const run = await generateQueryWorkflow.createRun();
    const result = await run.start({
      inputData: {prompt: 'something hard'},
      requestContext: rc as RequestContext,
    });

    expect(result.status).to.equal('success');
    if (result.status !== 'success') return;
    const wrapped = result.result as Record<string, unknown>;
    const out = (wrapped.failed as GenOut) ?? (wrapped as unknown as GenOut);
    // failedStep emits a deterministic empty payload; saveDataset is NOT
    // invoked because the predicate `passed === true` did not match.
    expect(out.datasetId).to.equal('');
    expect(out.sql).to.equal('');
    // The dountil predicate `attempts >= MAX_VALIDATION_ATTEMPTS` caps
    // iterations at exactly MAX_VALIDATION_ATTEMPTS — this is the user-
    // visible "stop wasting model calls" guarantee.
    expect(runAttempt.callCount).to.equal(MAX_VALIDATION_ATTEMPTS);
    sinon.assert.notCalled(datasetCreate);
  });

  // ──────────────────────────────────────────────────────────
  // Unanswerable: get-columns gate finds NO relevant tables →
  // fast-fail with a user message and ZERO SQL-gen attempts.
  // This is the restored v2 `get-tables`→`Failed` early gate: v3
  // had dropped it, so an unanswerable prompt fell through to the
  // dountil and burned MAX_VALIDATION_ATTEMPTS smart-tier SQL
  // generations before returning an empty dataset (and could even
  // accept executable-but-wrong SQL on the advisory last attempt).
  // ──────────────────────────────────────────────────────────

  it('Unanswerable branch — get-columns finds no relevant tables → fast-fail with replyToUser and ZERO SQL-gen attempts', async () => {
    stubLlm({'cache-judge': 'NotRelevant', 'template-judge': 'no_match'});
    // get-columns' LLM judges the question unanswerable. (pickRelevantTables
    // calls tracedGenerateText *internally*, so the label-stub can't reach it
    // — stub the exported helper the step actually imports instead. Its own
    // __unanswerable__ JSON parsing is covered in generate-helpers.unit.ts.)
    sinon.stub(helpers, 'pickRelevantTables').resolves({
      kind: 'unanswerable',
      reason: 'No revenue data is stored in these tables.',
    });
    // If this is ever called the gate failed — it must stay untouched.
    const runAttempt = sinon.stub().resolves({sql: 'SELECT 1', passed: true});

    const queryCache = {invoke: sinon.stub().resolves([])};
    const templateCache = {invoke: sinon.stub().resolves([])};
    const datasetCreate = sinon.stub();
    const schema = {tables: {employees: {columns: {id: {}, name: {}}}}};

    const rc = makeRc({
      queryCache,
      templateCache,
      schemaStore: {
        get: () => schema,
        filteredSchema: () => schema,
      } as never,
      datasetStore: {create: datasetCreate, findById: sinon.stub()} as never,
      authUser: {id: 'u1', tenantId: 't1'} as never,
      dbConnector: {
        validate: async () => undefined,
        execute: async () => [],
      } as never,
      sqlGenHelper: {runAttempt},
    });

    const run = await generateQueryWorkflow.createRun();
    const result = await run.start({
      inputData: {prompt: 'total revenue by region'},
      requestContext: rc as RequestContext,
    });

    expect(result.status).to.equal('success');
    if (result.status !== 'success') return;
    const wrapped = result.result as Record<string, unknown>;
    const out =
      (wrapped.failed as GenOut & {replyToUser?: string}) ??
      (wrapped as unknown as GenOut & {replyToUser?: string});

    expect(out.datasetId).to.equal('');
    // THE regression guard: an unanswerable question must not cost a
    // single smart-tier SQL generation.
    sinon.assert.notCalled(runAttempt);
    sinon.assert.notCalled(datasetCreate);
    // …and the user gets the clarification, not a silent empty dataset.
    expect(out.replyToUser).to.equal(
      'No revenue data is stored in these tables.',
    );
  });

  // ──────────────────────────────────────────────────────────
  // Guard the fallback: a get-columns LLM hiccup (junk / non-JSON)
  // must NOT be treated as unanswerable. It falls back to all tables
  // and the normal SQL-gen path runs — same as before the gate.
  // ──────────────────────────────────────────────────────────

  it('Unknown get-columns result (junk / LLM hiccup) falls back to all tables and proceeds to SQL gen', async () => {
    stubLlm({
      'cache-judge': 'NotRelevant',
      'template-judge': 'no_match',
      'generate-checklist': '',
    });
    // LLM hiccup / no clear verdict → unknown → fall back to all tables.
    sinon.stub(helpers, 'pickRelevantTables').resolves({kind: 'unknown'});
    const runAttempt = sinon.stub().resolves({
      sql: 'SELECT 1',
      passed: true,
      description: 'd',
    });

    const queryCache = {invoke: sinon.stub().resolves([])};
    const templateCache = {invoke: sinon.stub().resolves([])};
    const create = sinon.stub().resolves({id: 5});
    const findById = sinon.stub().resolves({id: 5, query: 'SELECT 1'});
    const schema = {tables: {employees: {columns: {id: {}, name: {}}}}};

    const rc = makeRc({
      queryCache,
      templateCache,
      schemaStore: {
        get: () => schema,
        filteredSchema: () => schema,
      } as never,
      datasetStore: {create, findById} as never,
      authUser: {id: 'u1', tenantId: 't1'} as never,
      dbConnector: {
        validate: async () => undefined,
        execute: async () => [],
      } as never,
      sqlGenHelper: {runAttempt},
    });

    const run = await generateQueryWorkflow.createRun();
    const result = await run.start({
      inputData: {prompt: 'list employees'},
      requestContext: rc as RequestContext,
    });

    expect(result.status).to.equal('success');
    if (result.status !== 'success') return;
    sinon.assert.called(runAttempt);
    sinon.assert.calledOnce(create);
  });
});

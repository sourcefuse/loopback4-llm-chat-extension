import {expect, sinon} from '@loopback/testlab';
import {RequestContext} from '@mastra/core/request-context';
import * as helpers from '../../mastra/workflows/db-query/_helpers';
import {generateQueryWorkflow} from '../../mastra/workflows/db-query/workflows/generate.workflow';
import {MAX_VALIDATION_ATTEMPTS} from '../../mastra/workflows/db-query/steps/constants';
import type {MastraRcShape} from '../../mastra/workflows/db-query/_helpers';

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
    overrides: Partial<MastraRcShape> = {},
  ): RequestContext<MastraRcShape> {
    const rc = new RequestContext<MastraRcShape>();
    rc.set('resourceId', overrides.resourceId ?? 't1:u1');
    rc.set('eventWriter', overrides.eventWriter ?? (() => undefined));
    // The accessors all fall back to chatLlm when the tier-specific
    // binding is absent — providing chatLlm alone is enough to make
    // the steps reach the (stubbed) `tracedGenerateText` boundary.
    rc.set('chatLlm', {modelId: 'mock'} as MastraRcShape['chatLlm']);
    if (overrides.queryCache) rc.set('queryCache', overrides.queryCache);
    if (overrides.templateCache)
      rc.set('templateCache', overrides.templateCache);
    if (overrides.schemaStore) rc.set('schemaStore', overrides.schemaStore);
    if (overrides.schemaHelper) rc.set('schemaHelper', overrides.schemaHelper);
    if (overrides.datasetStore) rc.set('datasetStore', overrides.datasetStore);
    if (overrides.templateStore)
      rc.set('templateStore', overrides.templateStore);
    if (overrides.templateHelper)
      rc.set('templateHelper', overrides.templateHelper);
    if (overrides.dbConnector) rc.set('dbConnector', overrides.dbConnector);
    if (overrides.authUser) rc.set('authUser', overrides.authUser);
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
  // FromTemplate path: template match → saveDatasetFromTemplateStep
  // ──────────────────────────────────────────────────────────

  it('FromTemplate branch — template judge match routes to saveDatasetFromTemplateStep and persists the resolved SQL', async () => {
    // cache judge: NotRelevant so cache misses
    // templates judge: "match 1" so template-id is taken
    stubLlm({'cache-judge': 'NotRelevant', 'template-judge': 'match 1'});
    sinon.stub(helpers, 'resolveTemplateById').resolves({
      sql: 'SELECT 1 FROM tmpl',
      description: 'from template',
    });
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
    const runSqlAttempt = sinon.stub(helpers, 'runSqlAttempt').resolves({
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
    expect(runSqlAttempt.callCount).to.equal(MAX_VALIDATION_ATTEMPTS);
    sinon.assert.notCalled(datasetCreate);
  });
});

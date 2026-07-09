import {expect, sinon} from '@loopback/testlab';
import {RequestContext} from '@mastra/core/request-context';
import type {Tool} from '@mastra/core/tools';
import {DatasetActionType} from '../../components/db-query/constant';
import {checkCacheNode} from '../../components/db-query/db-query.graph';
import {checkTemplatesNode} from '../../components/db-query/db-query.graph';
import {failedNode} from '../../components/db-query/db-query.graph';
import {getTablesNode} from '../../components/db-query/db-query.graph';
import {makeContainerNodeResolver} from '../fixtures/step-resolver';
import {postCacheAndTablesNode} from '../../components/db-query/db-query.graph';
import {returnCachedNode} from '../../components/db-query/db-query.graph';
import {saveDatasetNode} from '../../components/db-query/db-query.graph';
import {classifyPostCacheStatus} from '../../components/db-query/constants';
import {DbQueryNodes} from '../../components/db-query/nodes.enum';
import type {MastraRcShape} from '../../components/db-query/_helpers';
import {LLMStreamEventType} from '../../graphs/event.types';
import type {LLMStreamEvent} from '../../graphs/event.types';
import {PermissionHelper} from '../../components/db-query/services/permission-helper.service';

// Borrow the real filter so a `{findMissingPermissions}` stub behaves like a
// bound PermissionHelper (getTablesNode calls `.filterAuthorizedTables`, which
// delegates to the stubbed `findMissingPermissions`).
const {filterAuthorizedTables} = PermissionHelper.prototype;

/**
 * Step-level coverage for the canonical db-query workflow. Each step is a
 * Mastra `createStep` with a typed inputSchema + outputSchema; together
 * they form the NL→SQL graph the legacy v2 LangGraph extension produced
 * in main. The contract under test here is, per step:
 *   - schema-bounded output shape (datasetId/sql/cacheHit/...)
 *   - graceful degradation when a RequestContext dependency is unbound
 *   - status events emitted into the SSE pipeline via eventWriter
 *   - persistence side effects only on the success path
 */
describe('db-query workflow steps (unit)', () => {
  afterEach(() => sinon.restore());

  function makeRc(
    overrides: Partial<MastraRcShape> = {},
  ): RequestContext<MastraRcShape> {
    const rc = new RequestContext<MastraRcShape>();
    rc.set('resourceId', overrides.resourceId ?? 't1:u1');
    rc.set('eventWriter', overrides.eventWriter ?? (() => undefined));
    // Steps now read collaborators + resolved LLM tiers via constructor DI, so
    // route the test's stubs through the container resolver (not rc). The shell
    // still reads `resolveNode` + `eventWriter` from this rc, exactly as
    // WorkflowRunner wires it in production.
    const {resolver} = makeContainerNodeResolver({
      schemaStore: overrides.schemaStore,
      schemaHelper: overrides.schemaHelper,
      dataSetHelper: overrides.dataSetHelper,
      permissionHelper: overrides.permissionHelper,
      datasetStore: overrides.datasetStore,
      templateStore: overrides.templateStore,
      queryCache: overrides.queryCache,
      templateCache: overrides.templateCache,
      authUser: overrides.authUser,
      chatModel: overrides.chatLlm,
      cheapModel: overrides.cheapLlm,
      smartModel: overrides.smartLlm,
      smartNonThinkingModel: overrides.smartNonThinkingLlm,
    });
    rc.set('resolveNode', resolver);
    return rc;
  }

  // Capture every ToolStatus event so we can assert the user-visible
  // "Found relevant query in cache" / "Matched query template" log
  // entries the v2 UI used to render in the chat side-rail.
  function captureWriter() {
    const events: LLMStreamEvent[] = [];
    const writer = (e: LLMStreamEvent) => {
      events.push(e);
    };
    return {events, writer};
  }

  // The Mastra `execute` argument is over-typed for production use
  // (carries runId/runtimeContext/abort/bail/…). For unit tests we only
  // supply what the step actually reads; the cast lives in this single
  // helper so individual tests stay free of `as never` noise.
  type ExecuteArg<S extends {execute: unknown}> = Parameters<
    S['execute'] extends (...a: infer A) => unknown ? S['execute'] : never
  >[0];

  // ──────────────────────────────────────────────────────────
  // check-cache step
  // ──────────────────────────────────────────────────────────

  describe('checkCacheNode', () => {
    type Out = {
      cacheHit: boolean;
      datasetId?: string;
      sampleSql?: string;
      samplePrompt?: string;
    };

    async function runCheckCache(
      inputData: {prompt?: string},
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof checkCacheNode>;
      return checkCacheNode.execute(ctx) as Promise<Out>;
    }

    it('cache miss when prompt is empty (skip without invoking the cache)', async () => {
      const invoke = sinon.stub();
      const out = await runCheckCache(
        {},
        makeRc({queryCache: {invoke}, chatLlm: {} as MastraRcShape['chatLlm']}),
      );

      expect(out).to.eql({cacheHit: false});
      sinon.assert.notCalled(invoke);
    });

    it('cache miss when the cache binding is absent (consumer did not configure it)', async () => {
      const out = await runCheckCache({prompt: 'top customers'}, makeRc());
      expect(out).to.eql({cacheHit: false});
    });

    it('cache miss when the cache lookup throws (degrade, do NOT surface the error)', async () => {
      // Cache backend hiccups must not break the NL→SQL path — the
      // workflow falls through to live generation instead.
      const invoke = sinon.stub().rejects(new Error('vector store down'));
      const out = await runCheckCache(
        {prompt: 'x'},
        makeRc({
          queryCache: {invoke},
          chatLlm: {} as MastraRcShape['chatLlm'],
        }),
      );
      expect(out).to.eql({cacheHit: false});
    });

    it('cache hit on AsIs verdict returns the matched dataset id and emits a status event', async () => {
      // The judge is supposed to short-circuit: if the past query
      // exactly answers the new prompt, reuse it as-is.
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'list employees', metadata: {id: 'ds-7'}}]);
      const {events, writer} = captureWriter();
      const rc = makeRc({
        queryCache: {invoke},
        chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
        eventWriter: writer,
      });
      // Override the `tracedGenerateText` call indirectly by stubbing
      // ai.generateText is heavy; the step uses its own helper which
      // ultimately defers to the model. Easier seam: stub at the
      // module re-export by replacing `generateText` via sinon? The
      // step calls `tracedGenerateText`. We mock the helper module so
      // we don't fire a real model call.
      // For the unit-level assertion, run with a stub LLM that the
      // helper layer will short-circuit on (forceThinkingOff path).
      // Instead, isolate by stubbing the helper directly:
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'AsIs 1'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);

      const out = await runCheckCache({prompt: 'list employees'}, rc);

      expect(out.cacheHit).to.be.true();
      expect(out.datasetId).to.equal('ds-7');
      const status = events.find(e => e.type === LLMStreamEventType.ToolStatus);
      expect(status).to.not.be.undefined();
    });

    // v2 CheckCacheNode parity: an AsIs cache hit on a dataset the user lacks
    // table permission for must NOT be served — regenerate instead. (A
    // semantic-cache hit can surface another user's dataset in the same
    // tenant.) Restores the dropped check-cache permission test.
    it('AsIs cache hit on a dataset with missing permissions regenerates (no reuse)', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'salaries', metadata: {id: 'ds-9'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'AsIs 1'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);
      const checkPermissions = sinon.stub().resolves(['view_salaries']);

      const out = await runCheckCache(
        {prompt: 'salaries'},
        makeRc({
          queryCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
          dataSetHelper: {checkPermissions} as never,
        }),
      );

      expect(out).to.eql({cacheHit: false});
      sinon.assert.calledWith(checkPermissions, 'ds-9');
    });

    // v2 CheckCacheNode parity: a malformed judge index degrades to a miss
    // (regenerate) rather than throwing or serving a wrong dataset.
    it('AsIs verdict with an out-of-bounds index degrades to a cache MISS', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'p', metadata: {id: 'ds-1'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'AsIs 9'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);

      const out = await runCheckCache(
        {prompt: 'x'},
        makeRc({
          queryCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
        }),
      );
      expect(out).to.eql({cacheHit: false});
    });

    it('AsIs verdict with a non-numeric index degrades to a cache MISS', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'p', metadata: {id: 'ds-1'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'AsIs abc'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);

      const out = await runCheckCache(
        {prompt: 'x'},
        makeRc({
          queryCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
        }),
      );
      expect(out).to.eql({cacheHit: false});
    });

    it('Similar verdict is a cache MISS that seeds SQL gen with the validated example (sampleSql)', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'list staff', metadata: {id: 'ds-1'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'Similar 1'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);
      const findById = sinon.stub().resolves({
        id: 'ds-1',
        query: 'SELECT name FROM employees',
        actions: [],
      });

      const out = await runCheckCache(
        {prompt: 'x'},
        makeRc({
          queryCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
          datasetStore: {findById} as never,
        }),
      );

      // Still regenerates (cacheHit:false) but carries the worked example.
      expect(out.cacheHit).to.be.false();
      expect(out.sampleSql).to.equal('SELECT name FROM employees');
      expect(out.samplePrompt).to.equal('list staff');
    });

    it('Similar verdict does NOT seed with a disliked example (plain miss)', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'p', metadata: {id: 'ds-1'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'Similar 1'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);
      const findById = sinon.stub().resolves({
        id: 'ds-1',
        query: 'SELECT 1',
        actions: [{action: DatasetActionType.Disliked}],
      });

      const out = await runCheckCache(
        {prompt: 'x'},
        makeRc({
          queryCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
          datasetStore: {findById} as never,
        }),
      );

      expect(out).to.eql({cacheHit: false});
    });

    it('judge errors degrade to a cache MISS (never propagate)', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'p', metadata: {id: 'ds-1'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon.stub(helpers, 'tracedGenerateText').rejects(new Error('llm down'));

      const out = await runCheckCache(
        {prompt: 'x'},
        makeRc({
          queryCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
        }),
      );

      expect(out).to.eql({cacheHit: false});
    });
  });

  // ──────────────────────────────────────────────────────────
  // check-templates step
  // ──────────────────────────────────────────────────────────

  describe('checkTemplatesNode', () => {
    type Out = {matched: boolean; templateId?: string};

    async function runCheckTemplates(
      inputData: {prompt?: string},
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof checkTemplatesNode>;
      return checkTemplatesNode.execute(ctx) as Promise<Out>;
    }

    it('no match when prompt is empty', async () => {
      const out = await runCheckTemplates({}, makeRc());
      expect(out).to.eql({matched: false});
    });

    it('no match when the template cache returns no docs', async () => {
      const invoke = sinon.stub().resolves([]);
      const out = await runCheckTemplates(
        {prompt: 'x'},
        makeRc({
          templateCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
        }),
      );
      expect(out).to.eql({matched: false});
    });

    it('matched verdict surfaces the matched templateId', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'tmpl', metadata: {id: 'tmpl-9'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'match 1'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);

      const out = await runCheckTemplates(
        {prompt: 'list'},
        makeRc({
          templateCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
        }),
      );

      expect(out).to.eql({matched: true, templateId: 'tmpl-9'});
    });

    it('judge errors degrade to no-match (never propagate)', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 't', metadata: {id: 'tmpl-1'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon.stub(helpers, 'tracedGenerateText').rejects(new Error('llm down'));

      const out = await runCheckTemplates(
        {prompt: 'x'},
        makeRc({
          templateCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
        }),
      );
      expect(out).to.eql({matched: false});
    });

    // Tier 2 (v2 CheckTemplatesNode parity): a matched template whose tables
    // the user lacks permission for is skipped (matched:false) so the run
    // falls through to normal generation rather than serving its data.
    it('matched template with missing table permissions is skipped (no-match)', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'tmpl', metadata: {id: 'tmpl-9'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'match 1'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);
      const findById = sinon.stub().resolves({tables: ['salaries']});
      const findMissingPermissions = sinon.stub().returns(['view_salaries']);

      const out = await runCheckTemplates(
        {prompt: 'salaries'},
        makeRc({
          templateCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
          templateStore: {findById} as never,
          permissionHelper: {findMissingPermissions} as never,
        }),
      );

      expect(out).to.eql({matched: false});
      sinon.assert.calledWith(findMissingPermissions, ['salaries']);
    });

    it('matched template the user is authorised for still matches', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'tmpl', metadata: {id: 'tmpl-9'}}]);
      const helpers = await import('../../components/db-query/_helpers');
      sinon
        .stub(helpers, 'tracedGenerateText')
        .resolves({text: 'match 1'} as Awaited<
          ReturnType<typeof helpers.tracedGenerateText>
        >);
      const findById = sinon.stub().resolves({tables: ['employees']});
      const findMissingPermissions = sinon.stub().returns([]);

      const out = await runCheckTemplates(
        {prompt: 'list'},
        makeRc({
          templateCache: {invoke},
          chatLlm: {modelId: 'mock'} as MastraRcShape['chatLlm'],
          templateStore: {findById} as never,
          permissionHelper: {findMissingPermissions} as never,
        }),
      );

      expect(out).to.eql({matched: true, templateId: 'tmpl-9'});
    });
  });

  // ──────────────────────────────────────────────────────────
  // get-tables step
  // ──────────────────────────────────────────────────────────

  // get-tables is the DI-backed GetTablesNode class, exercised here through its
  // workflow shell (`getTablesNode`). makeRc publishes the static resolver, so
  // the shell delegates to the class which reads SchemaStore / PermissionHelper
  // from this same rc — identical wiring to WorkflowRunner.
  describe('getTablesNode', () => {
    async function runGetTables(
      rc?: RequestContext<MastraRcShape>,
    ): Promise<{tables: string[]}> {
      const ctx = {
        inputData: {prompt: 'x'},
        requestContext: rc,
      } as ExecuteArg<typeof getTablesNode>;
      return getTablesNode.execute(ctx) as Promise<{tables: string[]}>;
    }

    it('returns the full schema table set when SchemaStore is bound', async () => {
      const tables = Object.fromEntries([
        ['employees', {}],
        ['currencies', {}],
        ['exchange_rates', {}],
      ]);
      const get = sinon.stub().returns({
        tables,
      });
      const out = await runGetTables(makeRc({schemaStore: {get} as never}));
      expect(out.tables.sort()).to.eql([
        'currencies',
        'employees',
        'exchange_rates',
      ]);
    });

    it('returns an empty list when no SchemaStore is bound', async () => {
      const out = await runGetTables(makeRc());
      expect(out).to.eql({tables: []});
    });

    it('returns an empty list when SchemaStore.get throws (schema not loaded yet)', async () => {
      const out = await runGetTables(
        makeRc({
          schemaStore: {
            get: () => {
              throw new Error('schema not loaded');
            },
          } as never,
        }),
      );
      expect(out).to.eql({tables: []});
    });

    // v2 get-tables.node `_filterByPermissions` parity: tables the user has no
    // read permission for are dropped before the SQL generator ever sees the
    // schema, so the query can only reference accessible tables.
    it('filters out tables the user lacks permission for', async () => {
      const get = sinon.stub().returns({
        tables: Object.fromEntries([
          ['employees', {}],
          ['salaries', {}],
        ]),
      });
      // user can read employees but not salaries
      const findMissingPermissions = sinon
        .stub()
        .callsFake((t: string[]) =>
          t[0] === 'salaries' ? ['view_salaries'] : [],
        );

      const out = await runGetTables(
        makeRc({
          schemaStore: {get} as never,
          permissionHelper: {
            findMissingPermissions,
            filterAuthorizedTables,
          } as never,
        }),
      );

      expect(out.tables).to.eql(['employees']);
    });

    it('strips the schema prefix before the permission lookup', async () => {
      const get = sinon.stub().returns({
        tables: Object.fromEntries([['main.employees', {}]]),
      });
      const findMissingPermissions = sinon.stub().returns([]);

      const out = await runGetTables(
        makeRc({
          schemaStore: {get} as never,
          permissionHelper: {
            findMissingPermissions,
            filterAuthorizedTables,
          } as never,
        }),
      );

      expect(out.tables).to.eql(['main.employees']);
      // lookup uses the bare table name, not the schema-qualified one
      sinon.assert.calledWith(findMissingPermissions, ['employees']);
    });
  });

  // ──────────────────────────────────────────────────────────
  // post-cache-and-tables (fan-in classifier)
  // ──────────────────────────────────────────────────────────

  describe('postCacheAndTablesNode', () => {
    type Out = {
      fromCache: boolean;
      fromTemplate: boolean;
      status: 'AsIs' | 'FromTemplate' | 'Failed' | 'Continue';
      tables: string[];
      templateId?: string;
      datasetId?: string;
      prompt: string;
    };

    async function runPostCache(args: {
      cache?: {cacheHit: boolean; datasetId?: string};
      tables?: {tables: string[]};
      templates?: {matched: boolean; templateId?: string};
      init?: {prompt: string};
      input?: {prompt?: string};
    }): Promise<Out> {
      const stepResults: Record<string, unknown> = {};
      if (args.cache) stepResults[DbQueryNodes.CheckCache] = args.cache;
      if (args.tables) stepResults[DbQueryNodes.GetTables] = args.tables;
      if (args.templates)
        stepResults[DbQueryNodes.CheckTemplates] = args.templates;
      const ctx = {
        inputData: args.input ?? {},
        requestContext: makeRc(),
        getStepResult: (id: string) => stepResults[id],
        getInitData: () => args.init,
      } as ExecuteArg<typeof postCacheAndTablesNode>;
      return postCacheAndTablesNode.execute(ctx) as Promise<Out>;
    }

    it('reports status=AsIs when the cache hit, regardless of template match', async () => {
      // Cache wins so the workflow short-circuits before persisting
      // a new dataset. classifyPostCacheStatus is the gatekeeper.
      const out = await runPostCache({
        cache: {cacheHit: true, datasetId: 'ds-1'},
        tables: {tables: ['employees']},
        templates: {matched: true, templateId: 'tmpl-9'},
        init: {prompt: 'list'},
      });
      expect(out.status).to.equal('AsIs');
      expect(out.fromCache).to.be.true();
      expect(out.datasetId).to.equal('ds-1');
      expect(out.tables).to.eql(['employees']);
    });

    it('reports status=FromTemplate when only the template matched', async () => {
      const out = await runPostCache({
        cache: {cacheHit: false},
        tables: {tables: []},
        templates: {matched: true, templateId: 'tmpl-9'},
        init: {prompt: 'list'},
      });
      expect(out.status).to.equal('FromTemplate');
      expect(out.fromTemplate).to.be.true();
      expect(out.templateId).to.equal('tmpl-9');
    });

    it('reports status=Continue when neither path matched (full generation needed)', async () => {
      const out = await runPostCache({
        cache: {cacheHit: false},
        tables: {tables: ['employees']},
        templates: {matched: false},
        init: {prompt: 'list'},
      });
      expect(out.status).to.equal('Continue');
      expect(out.fromCache).to.be.false();
      expect(out.fromTemplate).to.be.false();
    });

    it('threads the initial prompt through so downstream steps see it (init wins over inputData)', async () => {
      const out = await runPostCache({
        cache: {cacheHit: false},
        tables: {tables: []},
        templates: {matched: false},
        init: {prompt: 'INIT-PROMPT'},
        input: {prompt: 'IGNORED'},
      });
      expect(out.prompt).to.equal('INIT-PROMPT');
    });

    it('falls back to inputData.prompt when getInitData is unavailable', async () => {
      const out = await runPostCache({
        cache: {cacheHit: false},
        tables: {tables: []},
        templates: {matched: false},
        input: {prompt: 'INPUT-PROMPT'},
      });
      expect(out.prompt).to.equal('INPUT-PROMPT');
    });

    it('classifyPostCacheStatus contract (table-driven, mirrors the runtime classifier)', () => {
      // The branch routing in generate.workflow depends on these four
      // exact values — adding/removing one would silently leave a
      // workflow run with no matching branch arm.
      expect(classifyPostCacheStatus(true, false)).to.equal('AsIs');
      expect(classifyPostCacheStatus(true, true)).to.equal('AsIs');
      expect(classifyPostCacheStatus(false, true)).to.equal('FromTemplate');
      expect(classifyPostCacheStatus(false, false)).to.equal('Continue');
    });
  });

  // ──────────────────────────────────────────────────────────
  // return-cached step (AsIs branch terminal)
  // ──────────────────────────────────────────────────────────

  describe('returnCachedNode', () => {
    type Out = {datasetId: string; sql: string};

    async function runReturnCached(
      inputData: {datasetId?: string},
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof returnCachedNode>;
      return returnCachedNode.execute(ctx) as Promise<Out>;
    }

    it('hydrates the dataset id + sql from the bound dataset store', async () => {
      const findById = sinon.stub().resolves({
        id: 99,
        query: 'SELECT * FROM employees',
      });
      const out = await runReturnCached(
        {datasetId: '99'},
        makeRc({datasetStore: {findById} as never}),
      );
      expect(out).to.eql({
        kind: 'cached',
        datasetId: '99',
        sql: 'SELECT * FROM employees',
      });
    });

    it('falls back to the input datasetId with empty sql when store is unbound', async () => {
      const out = await runReturnCached({datasetId: 'ds-1'}, makeRc());
      expect(out).to.eql({kind: 'cached', datasetId: 'ds-1', sql: ''});
    });

    it('falls back gracefully when the store throws (does not propagate)', async () => {
      const findById = sinon.stub().rejects(new Error('dataset not found'));
      const out = await runReturnCached(
        {datasetId: 'ds-1'},
        makeRc({datasetStore: {findById} as never}),
      );
      expect(out).to.eql({kind: 'cached', datasetId: 'ds-1', sql: ''});
    });
  });

  // ──────────────────────────────────────────────────────────
  // failed step (terminal sentinel)
  // ──────────────────────────────────────────────────────────

  describe('failedNode', () => {
    it('returns empty datasetId/sql so the tool wrapper emits ToolStatus.Failed', async () => {
      // The empty datasetId is the contract: the tool wrapper checks
      // `datasetId ? Completed : Failed` to decide which status to emit.
      const ctx = {
        inputData: {anything: true},
        requestContext: makeRc(),
      } as ExecuteArg<typeof failedNode>;
      const out = (await failedNode.execute(ctx)) as {
        datasetId: string;
        sql: string;
        replyToUser?: string;
      };
      expect(out.datasetId).to.equal('');
      expect(out.sql).to.equal('');
      // …and the generic rephrase message when no upstream reply/feedback
      // exists (v2 FailedNode default).
      expect(out.replyToUser).to.match(/rephrasing it or adding more detail/);
    });

    it('surfaces the last validation feedback in the failure message', async () => {
      const ctx = {
        inputData: {feedback: 'Query Validation Failed: unknown column foo'},
        requestContext: makeRc(),
      } as ExecuteArg<typeof failedNode>;
      const out = (await failedNode.execute(ctx)) as {replyToUser?: string};
      expect(out.replyToUser).to.match(/unknown column foo/);
    });

    it('prefers an upstream replyToUser (unanswerable gate) over the generic message', async () => {
      const ctx = {
        inputData: {replyToUser: 'No revenue data is stored in these tables.'},
        requestContext: makeRc(),
      } as ExecuteArg<typeof failedNode>;
      const out = (await failedNode.execute(ctx)) as {replyToUser?: string};
      expect(out.replyToUser).to.equal(
        'No revenue data is stored in these tables.',
      );
    });
  });

  // ──────────────────────────────────────────────────────────
  // save-dataset step (Continue branch terminal)
  // ──────────────────────────────────────────────────────────

  describe('saveDatasetNode', () => {
    type Input = {
      sql?: string;
      description?: string;
      prompt?: string;
      tables?: string[];
      cached?: boolean;
      datasetId?: string;
    };
    type Out = {datasetId: string; sql: string};

    async function runSave(
      inputData: Input,
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof saveDatasetNode>;
      return saveDatasetNode.execute(ctx) as Promise<Out>;
    }

    it('short-circuits to the cached datasetId without touching the store', async () => {
      // `cached:true` arrives from the AsIs branch fed back into the
      // workflow — re-persisting would create a duplicate row.
      const create = sinon.stub();
      const out = await runSave(
        {cached: true, datasetId: 'ds-1', sql: 'SELECT 1'},
        makeRc({datasetStore: {create} as never}),
      );
      expect(out).to.eql({datasetId: 'ds-1', sql: 'SELECT 1'});
      sinon.assert.notCalled(create);
    });

    it('fallback payload when no SQL was generated (workflow failure mid-stream)', async () => {
      const create = sinon.stub();
      const out = await runSave({}, makeRc({datasetStore: {create} as never}));
      expect(out).to.eql({datasetId: '', sql: ''});
      sinon.assert.notCalled(create);
    });

    it('fallback payload when DatasetStore or AuthUser is unbound (no persistence possible)', async () => {
      // resolvePersistDeps requires BOTH; the step must not throw when
      // a consumer ships SQL through without authentication wiring.
      const out = await runSave({sql: 'SELECT 1'}, makeRc());
      expect(out).to.eql({datasetId: '', sql: 'SELECT 1'});
    });

    it('persists a new dataset and returns the stringified id (number→string coercion contract)', async () => {
      // SQLite autoincrement returns numeric ids; tools/workflows are
      // string-typed downstream, so the coercion via idToString is the
      // single regression guard against "dataset disappears in the UI".
      const create = sinon.stub().resolves({id: 42});
      const rc = makeRc({
        datasetStore: {create} as never,
        authUser: {
          id: 'u1',
          tenantId: 't1',
          userTenantId: 'u1',
        } as never,
      });

      const out = await runSave(
        {
          sql: 'SELECT 1',
          description: 'all rows',
          prompt: 'list',
          tables: ['employees'],
        },
        rc,
      );

      expect(out).to.eql({datasetId: '42', sql: 'SELECT 1'});
      sinon.assert.calledOnce(create);
      const payload = create.firstCall.args[0] as Record<string, unknown>;
      expect(payload.query).to.equal('SELECT 1');
      expect(payload.description).to.equal('all rows');
      expect(payload.prompt).to.equal('list');
      expect(payload.tables).to.eql(['employees']);
      expect(payload.tenantId).to.equal('t1');
      expect(payload.votes).to.equal(0);
    });
  });

  // The `Tool` import keeps the typing surface honest — many of these
  // steps are reached from a Mastra Tool wrapper whose generic plumbs
  // through the same RequestContext. The import-only reference here
  // documents the linkage without firing a test.
  it('keeps the Tool type reachable for tool-wrapper integration tests', () => {
    type Wired = (tool: Tool) => void;
    const noop: Wired = () => undefined;
    expect(typeof noop).to.equal('function');
  });
});

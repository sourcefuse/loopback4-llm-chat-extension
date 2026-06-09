import {expect, sinon} from '@loopback/testlab';
import {RequestContext} from '@mastra/core/request-context';
import type {Tool} from '@mastra/core/tools';
import {DatasetActionType} from '../../components/db-query/constant';
import {checkCacheStep} from '../../mastra/workflows/db-query/steps/check-cache.step';
import {checkTemplatesStep} from '../../mastra/workflows/db-query/steps/check-templates.step';
import {failedStep} from '../../mastra/workflows/db-query/steps/failed.step';
import {getTablesStep} from '../../mastra/workflows/db-query/steps/get-tables.step';
import {postCacheAndTablesStep} from '../../mastra/workflows/db-query/steps/post-cache-and-tables.step';
import {returnCachedStep} from '../../mastra/workflows/db-query/steps/return-cached.step';
import {saveDatasetStep} from '../../mastra/workflows/db-query/steps/save-dataset.step';
import {
  STEP_CHECK_CACHE,
  STEP_CHECK_TEMPLATES,
  STEP_GET_TABLES,
  classifyPostCacheStatus,
} from '../../mastra/workflows/db-query/steps/constants';
import type {MastraRcShape} from '../../mastra/workflows/db-query/_helpers';
import {LLMStreamEventType} from '../../graphs/event.types';
import type {LLMStreamEvent} from '../../graphs/event.types';

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
    if (overrides.chatLlm) rc.set('chatLlm', overrides.chatLlm);
    if (overrides.cheapLlm) rc.set('cheapLlm', overrides.cheapLlm);
    if (overrides.queryCache) rc.set('queryCache', overrides.queryCache);
    if (overrides.templateCache)
      rc.set('templateCache', overrides.templateCache);
    if (overrides.schemaStore) rc.set('schemaStore', overrides.schemaStore);
    if (overrides.schemaHelper) rc.set('schemaHelper', overrides.schemaHelper);
    if (overrides.datasetStore) rc.set('datasetStore', overrides.datasetStore);
    if (overrides.authUser) rc.set('authUser', overrides.authUser);
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

  describe('checkCacheStep', () => {
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
      } as ExecuteArg<typeof checkCacheStep>;
      return checkCacheStep.execute(ctx) as Promise<Out>;
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
      const helpers = await import('../../mastra/workflows/db-query/_helpers');
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

    it('Similar verdict is a cache MISS that seeds SQL gen with the validated example (sampleSql)', async () => {
      const invoke = sinon
        .stub()
        .resolves([{pageContent: 'list staff', metadata: {id: 'ds-1'}}]);
      const helpers = await import('../../mastra/workflows/db-query/_helpers');
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
      const helpers = await import('../../mastra/workflows/db-query/_helpers');
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
      const helpers = await import('../../mastra/workflows/db-query/_helpers');
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

  describe('checkTemplatesStep', () => {
    type Out = {matched: boolean; templateId?: string};

    async function runCheckTemplates(
      inputData: {prompt?: string},
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof checkTemplatesStep>;
      return checkTemplatesStep.execute(ctx) as Promise<Out>;
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
      const helpers = await import('../../mastra/workflows/db-query/_helpers');
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
      const helpers = await import('../../mastra/workflows/db-query/_helpers');
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
  });

  // ──────────────────────────────────────────────────────────
  // get-tables step
  // ──────────────────────────────────────────────────────────

  describe('getTablesStep', () => {
    async function runGetTables(
      rc?: RequestContext<MastraRcShape>,
    ): Promise<{tables: string[]}> {
      const ctx = {
        inputData: {prompt: 'x'},
        requestContext: rc,
      } as ExecuteArg<typeof getTablesStep>;
      return getTablesStep.execute(ctx) as Promise<{tables: string[]}>;
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
  });

  // ──────────────────────────────────────────────────────────
  // post-cache-and-tables (fan-in classifier)
  // ──────────────────────────────────────────────────────────

  describe('postCacheAndTablesStep', () => {
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
      if (args.cache) stepResults[STEP_CHECK_CACHE] = args.cache;
      if (args.tables) stepResults[STEP_GET_TABLES] = args.tables;
      if (args.templates) stepResults[STEP_CHECK_TEMPLATES] = args.templates;
      const ctx = {
        inputData: args.input ?? {},
        getStepResult: (id: string) => stepResults[id],
        getInitData: () => args.init,
      } as ExecuteArg<typeof postCacheAndTablesStep>;
      return postCacheAndTablesStep.execute(ctx) as Promise<Out>;
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

  describe('returnCachedStep', () => {
    type Out = {datasetId: string; sql: string};

    async function runReturnCached(
      inputData: {datasetId?: string},
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof returnCachedStep>;
      return returnCachedStep.execute(ctx) as Promise<Out>;
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
      expect(out).to.eql({datasetId: '99', sql: 'SELECT * FROM employees'});
    });

    it('falls back to the input datasetId with empty sql when store is unbound', async () => {
      const out = await runReturnCached({datasetId: 'ds-1'}, makeRc());
      expect(out).to.eql({datasetId: 'ds-1', sql: ''});
    });

    it('falls back gracefully when the store throws (does not propagate)', async () => {
      const findById = sinon.stub().rejects(new Error('dataset not found'));
      const out = await runReturnCached(
        {datasetId: 'ds-1'},
        makeRc({datasetStore: {findById} as never}),
      );
      expect(out).to.eql({datasetId: 'ds-1', sql: ''});
    });
  });

  // ──────────────────────────────────────────────────────────
  // failed step (terminal sentinel)
  // ──────────────────────────────────────────────────────────

  describe('failedStep', () => {
    it('returns empty datasetId/sql so the tool wrapper emits ToolStatus.Failed', async () => {
      // The empty datasetId is the contract: the tool wrapper checks
      // `datasetId ? Completed : Failed` to decide which status to emit.
      const ctx = {
        inputData: {anything: true},
      } as ExecuteArg<typeof failedStep>;
      const out = (await failedStep.execute(ctx)) as {
        datasetId: string;
        sql: string;
        replyToUser?: string;
      };
      expect(out.datasetId).to.equal('');
      expect(out.sql).to.equal('');
      // …and a non-empty failure message (never a silent empty dataset).
      expect(out.replyToUser).to.be.a.String();
      expect(out.replyToUser?.length).to.be.greaterThan(0);
    });

    it('surfaces the last validation feedback in the failure message', async () => {
      const ctx = {
        inputData: {feedback: 'Query Validation Failed: unknown column foo'},
      } as ExecuteArg<typeof failedStep>;
      const out = (await failedStep.execute(ctx)) as {replyToUser?: string};
      expect(out.replyToUser).to.match(/unknown column foo/);
    });

    it('prefers an upstream replyToUser (unanswerable gate) over the generic message', async () => {
      const ctx = {
        inputData: {replyToUser: 'No revenue data is stored in these tables.'},
      } as ExecuteArg<typeof failedStep>;
      const out = (await failedStep.execute(ctx)) as {replyToUser?: string};
      expect(out.replyToUser).to.equal(
        'No revenue data is stored in these tables.',
      );
    });
  });

  // ──────────────────────────────────────────────────────────
  // save-dataset step (Continue branch terminal)
  // ──────────────────────────────────────────────────────────

  describe('saveDatasetStep', () => {
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
      } as ExecuteArg<typeof saveDatasetStep>;
      return saveDatasetStep.execute(ctx) as Promise<Out>;
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

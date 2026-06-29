import {expect, sinon} from '@loopback/testlab';
import {RequestContext} from '@mastra/core/request-context';
import {callQueryGenerationStep} from '../../components/visualization/workflows/visualization.workflow';
import {getDatasetDataStep} from '../../components/visualization/workflows/visualization.workflow';
import {renderVisualizationStep} from '../../components/visualization/workflows/visualization.workflow';
import {selectVisualisationStep} from '../../components/visualization/workflows/visualization.workflow';
import {
  buildVisualizerSelectionPrompt,
  DEFAULT_CHART_TYPE,
  fetchDatasetDescriptor,
  fetchDatasetRows,
  parseVisualizerSelection,
  pickFromBranch,
  pickVisualizer,
} from '../../components/visualization/steps/shared';
import type {MastraRcShape} from '../../components/db-query/steps/_helpers';
import type {IVisualizer} from '../../components/visualization/types';
import {makeContainerStepResolver} from '../fixtures/step-resolver';

/**
 * Visualization workflow is the second half of the chart pipeline: given
 * a userQuery + (optional) datasetId, route through optional query
 * generation, fetch dataset rows, then render a typed chart config.
 *
 * The graph topology under test:
 *   selectVisualisation → callQueryGeneration → getDatasetData → renderVisualization
 *
 * Each step is a Mastra `createStep`; their schemas + degradation paths
 * are the public contract a host application relies on.
 */
describe('visualization workflow steps (unit)', () => {
  afterEach(() => sinon.restore());

  function makeRc(
    overrides: Partial<MastraRcShape> = {},
  ): RequestContext<MastraRcShape> {
    const rc = new RequestContext<MastraRcShape>();
    rc.set('eventWriter', overrides.eventWriter ?? (() => undefined));
    rc.set('resourceId', overrides.resourceId ?? 't1:u1');
    // Viz steps read visualizers (tagged) + datasetStore/dataSetHelper + model
    // tiers via constructor DI, so route the stubs through the container
    // resolver. The shell reads `resolveStep` + `eventWriter` from this rc.
    const {resolver} = makeContainerStepResolver({
      visualizers: overrides.visualizers as IVisualizer[] | undefined,
      datasetStore: overrides.datasetStore,
      dataSetHelper: overrides.dataSetHelper,
      chatModel: overrides.chatLlm,
      cheapModel: overrides.cheapLlm,
    });
    rc.set('resolveStep', resolver);
    return rc;
  }

  type ExecuteArg<S extends {execute: unknown}> = Parameters<
    S['execute'] extends (...a: infer A) => unknown ? S['execute'] : never
  >[0];

  function makeVisualizer(name: string): IVisualizer {
    return {
      name,
      // The `getConfig` shape is the visualizer interface used by
      // `renderVisualizationStep`; per-visualizer schemas live under
      // src/components/visualization/visualizers/* and are covered
      // by their own unit tests.
      getConfig: sinon.stub().resolves({type: name, options: {}}),
    } as unknown as IVisualizer;
  }

  // ──────────────────────────────────────────────────────────
  // select-visualisation
  // ──────────────────────────────────────────────────────────

  describe('selectVisualisationStep', () => {
    type Out = {
      datasetId: string;
      needsQuery: boolean;
      chartType: string;
      userQuery: string;
    };

    async function runSelect(
      inputData: {datasetId: string; userQuery: string; type?: string},
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof selectVisualisationStep>;
      return selectVisualisationStep.execute(ctx) as Promise<Out>;
    }

    it('honours the consumer-supplied chart type verbatim (explicit > auto-pick)', async () => {
      const out = await runSelect(
        {datasetId: 'ds-1', userQuery: 'q', type: 'line'},
        makeRc({visualizers: [makeVisualizer('bar'), makeVisualizer('line')]}),
      );
      expect(out.chartType).to.equal('line');
    });

    it("picks the first registered visualizer when no explicit type is supplied (user said 'show me a chart')", async () => {
      // The first registered visualizer is the host app's preferred
      // default — there's no "preferences" knob in the schema so the
      // ordering of `visualizers` becomes the contract.
      const out = await runSelect(
        {datasetId: 'ds-1', userQuery: 'q'},
        makeRc({visualizers: [makeVisualizer('pie'), makeVisualizer('bar')]}),
      );
      expect(out.chartType).to.equal('pie');
    });

    it("falls back to DEFAULT_CHART_TYPE='bar' when no visualizers are registered and no explicit type", async () => {
      // Visualizers slot is empty in the bare extension config — the
      // step must still produce a valid downstream payload.
      const out = await runSelect(
        {datasetId: 'ds-1', userQuery: 'q'},
        makeRc(),
      );
      expect(out.chartType).to.equal(DEFAULT_CHART_TYPE);
      expect(DEFAULT_CHART_TYPE).to.equal('bar');
    });

    it('signals needsQuery=true when the caller did not pre-resolve a datasetId', async () => {
      const out = await runSelect({datasetId: '', userQuery: 'q'}, makeRc());
      expect(out.needsQuery).to.be.true();
    });

    it('signals needsQuery=false when the caller already has a datasetId', async () => {
      const out = await runSelect(
        {datasetId: 'ds-1', userQuery: 'q'},
        makeRc(),
      );
      expect(out.needsQuery).to.be.false();
    });
  });

  // ──────────────────────────────────────────────────────────
  // call-query-generation
  // ──────────────────────────────────────────────────────────

  describe('callQueryGenerationStep', () => {
    type Out = {
      datasetId: string;
      needsQuery: boolean;
      chartType: string;
      userQuery: string;
    };

    async function runCall(
      inputData: {
        datasetId: string;
        needsQuery: boolean;
        chartType: string;
        userQuery: string;
      },
      mastra?: object,
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        mastra,
        requestContext: rc,
      } as ExecuteArg<typeof callQueryGenerationStep>;
      return callQueryGenerationStep.execute(ctx) as Promise<Out>;
    }

    it('pass-through when the upstream step already resolved a datasetId (no nested workflow call)', async () => {
      const getWorkflow = sinon.stub();
      const out = await runCall(
        {
          datasetId: 'ds-1',
          needsQuery: false,
          chartType: 'bar',
          userQuery: 'q',
        },
        {getWorkflow},
        makeRc(),
      );

      expect(out.datasetId).to.equal('ds-1');
      expect(out.needsQuery).to.be.false();
      sinon.assert.notCalled(getWorkflow);
    });

    it('returns needsQuery=true when no Mastra instance is wired (graceful degradation, not throw)', async () => {
      const out = await runCall(
        {datasetId: '', needsQuery: true, chartType: 'bar', userQuery: 'q'},
        undefined,
        makeRc(),
      );

      expect(out.needsQuery).to.be.true();
      expect(out.datasetId).to.equal('');
    });

    it('unwraps the generateQueryWorkflow save-dataset branch and returns the resulting datasetId', async () => {
      // The generate workflow nests its terminal output under
      // `result['save-dataset']` (Mastra `branch()` arm key). The step
      // is responsible for digging through that wrapper.
      const start = sinon.stub().resolves({
        status: 'success',
        result: {'save-dataset': {datasetId: 'ds-77', sql: 'SELECT 1'}},
      });
      const createRun = sinon.stub().resolves({start});
      const getWorkflow = sinon.stub().returns({createRun});

      const out = await runCall(
        {datasetId: '', needsQuery: true, chartType: 'bar', userQuery: 'q'},
        {getWorkflow},
        makeRc(),
      );

      expect(out.datasetId).to.equal('ds-77');
      expect(out.needsQuery).to.be.false();
      sinon.assert.calledOnceWithExactly(getWorkflow, 'generateQueryWorkflow');
    });

    it('falls back to top-level datasetId when the save-dataset branch wrapper is absent', async () => {
      // Defensive path — if Mastra ever flattens branch results, the
      // step still produces a usable datasetId without changes.
      const start = sinon.stub().resolves({
        status: 'success',
        result: {datasetId: 'flat-ds', sql: 'SELECT 1'},
      });
      const createRun = sinon.stub().resolves({start});
      const getWorkflow = sinon.stub().returns({createRun});

      const out = await runCall(
        {datasetId: '', needsQuery: true, chartType: 'bar', userQuery: 'q'},
        {getWorkflow},
        makeRc(),
      );

      expect(out.datasetId).to.equal('flat-ds');
    });

    it("returns datasetId='' when the nested workflow produced nothing usable", async () => {
      const start = sinon.stub().resolves({result: {}});
      const createRun = sinon.stub().resolves({start});
      const getWorkflow = sinon.stub().returns({createRun});

      const out = await runCall(
        {datasetId: '', needsQuery: true, chartType: 'bar', userQuery: 'q'},
        {getWorkflow},
        makeRc(),
      );

      expect(out.datasetId).to.equal('');
    });
  });

  // ──────────────────────────────────────────────────────────
  // get-dataset-data
  // ──────────────────────────────────────────────────────────

  describe('getDatasetDataStep', () => {
    type Out = {
      datasetId: string;
      rows: unknown[];
      chartType: string;
      userQuery: string;
      sql?: string;
      description?: string;
    };

    async function runGet(
      inputData: unknown,
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof getDatasetDataStep>;
      return getDatasetDataStep.execute(ctx) as Promise<Out>;
    }

    it('fetches descriptor + rows when a dataset id arrives from the call-query-generation branch', async () => {
      // Real upstream payload shape — `branch()` arm wrapper.
      const findById = sinon
        .stub()
        .resolves({id: 1, query: 'SELECT 1', description: 'd'});
      const getDataFromDataset = sinon.stub().resolves([{a: 1}, {a: 2}]);

      const out = await runGet(
        {
          'call-query-generation': {
            datasetId: 'ds-1',
            chartType: 'bar',
            userQuery: 'q',
          },
        },
        makeRc({
          datasetStore: {findById} as never,
          dataSetHelper: {getDataFromDataset} as never,
        }),
      );

      expect(out.datasetId).to.equal('ds-1');
      expect(out.rows).to.eql([{a: 1}, {a: 2}]);
      expect(out.sql).to.equal('SELECT 1');
      expect(out.description).to.equal('d');
    });

    it('emits an empty rows array when DataSetHelper.getDataFromDataset throws (chart should render gracefully)', async () => {
      const findById = sinon.stub().resolves({id: 1, query: 'SELECT 1'});
      const getDataFromDataset = sinon.stub().rejects(new Error('db down'));

      const out = await runGet(
        {datasetId: 'ds-1', chartType: 'bar', userQuery: 'q'},
        makeRc({
          datasetStore: {findById} as never,
          dataSetHelper: {getDataFromDataset} as never,
        }),
      );

      expect(out.rows).to.eql([]);
      expect(out.sql).to.equal('SELECT 1');
    });

    it('emits empty descriptor when DatasetStore.findById throws (dataset deleted between steps)', async () => {
      const findById = sinon.stub().rejects(new Error('not found'));
      const getDataFromDataset = sinon.stub().resolves([]);

      const out = await runGet(
        {datasetId: 'ds-1', chartType: 'bar', userQuery: 'q'},
        makeRc({
          datasetStore: {findById} as never,
          dataSetHelper: {getDataFromDataset} as never,
        }),
      );

      expect(out.sql).to.be.undefined();
      expect(out.description).to.be.undefined();
    });

    it('defaults chartType to DEFAULT_CHART_TYPE when upstream sent no chartType (defensive)', async () => {
      const out = await runGet({datasetId: 'ds-1', userQuery: 'q'}, makeRc());
      expect(out.chartType).to.equal(DEFAULT_CHART_TYPE);
    });
  });

  // ──────────────────────────────────────────────────────────
  // render-visualization
  // ──────────────────────────────────────────────────────────

  describe('renderVisualizationStep', () => {
    type Out = {
      visualization: string;
      chartConfig: unknown;
      datasetId: string;
      sql?: string;
      description?: string;
    };

    async function runRender(
      inputData: {
        datasetId: string;
        rows: unknown[];
        chartType: string;
        userQuery: string;
        sql?: string;
        description?: string;
      },
      rc?: RequestContext<MastraRcShape>,
    ): Promise<Out> {
      const ctx = {
        inputData,
        requestContext: rc,
      } as ExecuteArg<typeof renderVisualizationStep>;
      return renderVisualizationStep.execute(ctx) as Promise<Out>;
    }

    it('returns the visualizer-built config when a matching visualizer is registered', async () => {
      const viz = makeVisualizer('bar');
      const out = await runRender(
        {
          datasetId: 'ds-1',
          rows: [{a: 1}],
          chartType: 'bar',
          userQuery: 'q',
          sql: 'SELECT 1',
        },
        makeRc({visualizers: [viz]}),
      );

      expect(out.visualization).to.equal('bar');
      expect(out.chartConfig).to.eql({type: 'bar', options: {}});
      expect(out.datasetId).to.equal('ds-1');
      expect(out.sql).to.equal('SELECT 1');
    });

    it('returns an empty chartConfig when no visualizers are registered (host opted out of charts)', async () => {
      const out = await runRender(
        {
          datasetId: 'ds-1',
          rows: [],
          chartType: 'bar',
          userQuery: 'q',
        },
        makeRc(),
      );

      expect(out.visualization).to.equal('bar');
      expect(out.chartConfig).to.eql({});
    });

    it('falls back to empty chartConfig when the visualizer.getConfig throws (LLM/parse failure)', async () => {
      // Visualizers can internally call generateObject which fails on
      // bad LLM output — the chart panel should render an empty state,
      // not crash the workflow.
      const viz = makeVisualizer('bar');
      (viz.getConfig as sinon.SinonStub).rejects(new Error('zod parse failed'));

      const out = await runRender(
        {
          datasetId: 'ds-1',
          rows: [{a: 1}],
          chartType: 'bar',
          userQuery: 'q',
        },
        makeRc({visualizers: [viz]}),
      );

      expect(out.chartConfig).to.eql({});
      expect(out.visualization).to.equal('bar');
    });
  });

  // ──────────────────────────────────────────────────────────
  // shared helpers
  // ──────────────────────────────────────────────────────────

  describe('shared helpers', () => {
    describe('pickVisualizer', () => {
      it('returns undefined when no visualizers are registered', () => {
        expect(pickVisualizer([], 'bar')).to.be.undefined();
      });
      it('returns the exact-name match when present', () => {
        const bar = makeVisualizer('bar');
        const line = makeVisualizer('line');
        expect(pickVisualizer([bar, line], 'line')).to.equal(line);
      });
      it('falls back to the FIRST visualizer when no name matches (deterministic default)', () => {
        const bar = makeVisualizer('bar');
        const line = makeVisualizer('line');
        expect(pickVisualizer([bar, line], 'pie')).to.equal(bar);
      });
    });

    describe('pickFromBranch', () => {
      it('unwraps a branch-arm-keyed payload', () => {
        const out = pickFromBranch(
          {'call-query-generation': {datasetId: 'ds-1'}},
          'call-query-generation',
        );
        expect(out).to.eql({datasetId: 'ds-1'});
      });
      it('returns the input as-is when the branch key is missing', () => {
        const out = pickFromBranch(
          {datasetId: 'ds-1'},
          'call-query-generation',
        );
        expect(out).to.eql({datasetId: 'ds-1'});
      });
      it('returns an empty record for non-object input', () => {
        expect(pickFromBranch(null, 'x')).to.eql({});
        expect(pickFromBranch('str', 'x')).to.eql({});
      });
    });

    describe('fetchDatasetDescriptor', () => {
      it('returns empty when datasetId is empty (no store call)', async () => {
        const findById = sinon.stub();
        const out = await fetchDatasetDescriptor({findById} as never, '');
        expect(out).to.eql({});
        sinon.assert.notCalled(findById);
      });
      it('returns empty when store is undefined', async () => {
        expect(await fetchDatasetDescriptor(undefined, 'ds-1')).to.eql({});
      });
      it('hydrates query+description on hit', async () => {
        const findById = sinon
          .stub()
          .resolves({id: 1, query: 'SELECT 1', description: 'd'});
        const out = await fetchDatasetDescriptor({findById} as never, 'ds-1');
        expect(out).to.eql({sql: 'SELECT 1', description: 'd'});
      });
      it('swallows store errors (returns empty)', async () => {
        const findById = sinon.stub().rejects(new Error('boom'));
        expect(
          await fetchDatasetDescriptor({findById} as never, 'ds-1'),
        ).to.eql({});
      });
    });

    describe('fetchDatasetRows', () => {
      it('returns [] when helper or datasetId is missing', async () => {
        expect(await fetchDatasetRows(undefined, 'ds-1')).to.eql([]);
        const getDataFromDataset = sinon.stub();
        expect(
          await fetchDatasetRows({getDataFromDataset} as never, ''),
        ).to.eql([]);
        sinon.assert.notCalled(getDataFromDataset);
      });
      it('coerces a non-array result to [] (defensive against helper contract drift)', async () => {
        const getDataFromDataset = sinon.stub().resolves('oops');
        expect(
          await fetchDatasetRows({getDataFromDataset} as never, 'ds-1'),
        ).to.eql([]);
      });
      it('swallows helper errors and returns []', async () => {
        const getDataFromDataset = sinon.stub().rejects(new Error('db down'));
        expect(
          await fetchDatasetRows({getDataFromDataset} as never, 'ds-1'),
        ).to.eql([]);
      });
    });

    describe('parseVisualizerSelection (chart-pick robustness)', () => {
      const viz = [
        {name: 'bar'},
        {name: 'line'},
        {name: 'pie'},
      ] as IVisualizer[];

      it('matches an exact name reply', () => {
        expect(parseVisualizerSelection('line', viz)).to.eql({
          chartType: 'line',
        });
      });

      it('picks the LAST-mentioned name in a reasoned reply (not the first)', () => {
        // The old includes() fallback returned "bar" (first in the array, and
        // first mentioned). The verdict is "line".
        expect(
          parseVisualizerSelection('Not a bar chart — use line.', viz),
        ).to.eql({chartType: 'line'});
      });

      it('does not match a name embedded in another word (line ∉ timeline)', () => {
        expect(
          parseVisualizerSelection('show the timeline of sales', viz),
        ).to.eql({chartType: 'bar'}); // falls back to first; no false "line"
      });

      it('treats a "none: reason" reply as a rejection', () => {
        const r = parseVisualizerSelection('none: single scalar value', viz);
        expect(r).to.have.property('rejected', true);
      });

      it('falls back to the first visualizer on an unrecognised reply', () => {
        expect(parseVisualizerSelection('rainbow', viz)).to.eql({
          chartType: 'bar',
        });
      });
    });

    describe('buildVisualizerSelectionPrompt (data context)', () => {
      const viz = [{name: 'bar', description: 'bars'}] as IVisualizer[];

      it('includes the SQL + description data block when provided', () => {
        const p = buildVisualizerSelectionPrompt('chart it', viz, {
          sql: 'SELECT month, total FROM sales',
          description: 'monthly totals',
        });
        expect(p).to.match(/<data>/);
        expect(p).to.match(/SELECT month, total FROM sales/);
        expect(p).to.match(/monthly totals/);
      });

      it('omits the data block when no data context is given', () => {
        const p = buildVisualizerSelectionPrompt('chart it', viz);
        expect(p).to.not.match(/<data>/);
      });
    });
  });
});

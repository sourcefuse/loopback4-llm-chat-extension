import {expect, sinon} from '@loopback/testlab';
import {Mastra} from '@mastra/core';
import {RequestContext} from '@mastra/core/request-context';
import type {Tool, ToolExecutionContext} from '@mastra/core/tools';
import {GetDataAsDatasetTool} from '../../components/db-query/tools/get-data-as-dataset.tool';
import {ImproveDatasetTool} from '../../components/db-query/tools/improve-dataset.tool';
import {GenerateVisualizationTool} from '../../components/visualization/tools/generate-visualization.tool';
import {LLMStreamEventType} from '../../graphs/event.types';
import type {LLMStreamEvent} from '../../graphs/event.types';
import {ToolStatus} from '../../graphs/types';
import {DbQueryNodes} from '../../components/db-query/nodes.enum';

/**
 * Mastra-shaped tool wrapper coverage. Each tool:
 *   1. Owns its workflow id and an inputSchema the agent's tool-call
 *      protocol depends on.
 *   2. Emits the canonical SSE event lifecycle:
 *        Running → (Tool payload) → Completed | Failed | AwaitingApproval
 *   3. Unwraps the workflow's branch-arm-keyed output so the AI sees
 *      a clean datasetId / chart-config payload.
 *   4. Hands the AI back a short readout (never raw rows by default).
 *
 * Every assertion below pins one of those four behaviours so a refactor
 * that breaks the agent ↔ UI ↔ workflow contract fails loudly.
 */
describe('mastra tool wrappers (unit)', () => {
  afterEach(() => sinon.restore());

  // Build a Mastra stub where `getWorkflow(id)` returns a workflow whose
  // `createRun().start(...)` resolves to the supplied `startResult`.
  // Returns the spies + the stub so the test can assert on call args.
  function makeMastraWith(
    workflowId: string,
    startResult: unknown,
  ): {mastra: Mastra; start: sinon.SinonStub; getWorkflow: sinon.SinonStub} {
    const start = sinon.stub().resolves(startResult);
    const createRun = sinon.stub().resolves({start});
    const wf = {createRun};
    const getWorkflow = sinon
      .stub()
      .callsFake((id: string) => (id === workflowId ? wf : undefined));
    const mastra = {getWorkflow} as unknown as Mastra;
    return {mastra, start, getWorkflow};
  }

  // Capture the SSE event stream the tool emits via the RequestContext
  // `eventWriter` callback.
  function captureWriter(): {
    events: LLMStreamEvent[];
    writer: (e: LLMStreamEvent) => void;
  } {
    const events: LLMStreamEvent[] = [];
    return {events, writer: (e: LLMStreamEvent) => events.push(e)};
  }

  // Tool ctx: a minimal ToolExecutionContext shape with requestContext +
  // optional toolCallId on the agent. Mastra's full ctx carries tracing,
  // runtimeContext, etc — none consumed by these tool bodies beyond the
  // pass-through into workflow.start().
  function makeCtx(
    rc: RequestContext,
    toolCallId?: string,
  ): ToolExecutionContext {
    return {
      requestContext: rc,
      agent: toolCallId ? {toolCallId} : undefined,
    } as unknown as ToolExecutionContext;
  }

  // Convenience: build a RequestContext with an eventWriter (and nothing
  // else by default).
  function makeRc(writer: (e: LLMStreamEvent) => void): RequestContext {
    const rc = new RequestContext();
    rc.set('eventWriter', writer as never);
    return rc;
  }

  // The build() exposes a Tool whose .execute is what the agent calls.
  // Mastra's Tool typing makes execute optional; extract once.
  function executeFor(tool: Tool): NonNullable<Tool['execute']> {
    if (!tool.execute) throw new Error('tool exposed no execute()');
    return tool.execute;
  }

  // ──────────────────────────────────────────────────────────────
  // GetDataAsDatasetTool
  // ──────────────────────────────────────────────────────────────

  describe('GetDataAsDatasetTool', () => {
    it('emits Running → Tool → Completed and returns the AI readout when the workflow persists a dataset', async () => {
      const {mastra, start, getWorkflow} = makeMastraWith(
        'generateQueryWorkflow',
        {
          status: 'success',
          result: {
            [DbQueryNodes.SaveDataset]: {datasetId: 'ds-1', sql: 'SELECT 1'},
          },
        },
      );
      const {events, writer} = captureWriter();
      const rc = makeRc(writer);

      const tool = new GetDataAsDatasetTool(mastra).build();
      const result = await executeFor(tool)(
        {prompt: 'list employees'},
        makeCtx(rc, 'call-42'),
      );

      sinon.assert.calledOnceWithExactly(getWorkflow, 'generateQueryWorkflow');
      sinon.assert.calledOnce(start);

      const types = events.map(e => e.type);
      expect(types).to.eql([
        LLMStreamEventType.ToolStatus, // Running
        LLMStreamEventType.Tool, // Tool payload
        LLMStreamEventType.ToolStatus, // Completed
      ]);

      const running = events[0] as unknown as {
        type: LLMStreamEventType;
        data: {id: string; status: ToolStatus};
      };
      const toolEvt = events[1] as unknown as {
        type: LLMStreamEventType;
        data: {tool: string; data: {datasetId: string; sql: string}};
      };
      const completed = events[2] as unknown as {
        type: LLMStreamEventType;
        data: {status: ToolStatus};
      };
      expect(running.data.status).to.equal(ToolStatus.Running);
      expect(running.data.id).to.equal('call-42');
      expect(toolEvt.data.tool).to.equal('get-data-as-dataset');
      expect(toolEvt.data.data).to.eql({datasetId: 'ds-1', sql: 'SELECT 1'});
      expect(completed.data.status).to.equal(ToolStatus.Completed);

      // The AI gets a string acknowledgement, never the rows.
      expect(typeof result).to.equal('string');
      expect(result as string).to.match(/Dataset generated/i);
    });

    it('emits ToolStatus.Failed when the workflow returned an empty branch (datasetId="" sentinel)', async () => {
      // The workflow's `failed` arm produces `{datasetId:'', sql:''}` —
      // the tool must classify that as failed even though the workflow
      // status itself was `success`.
      const {mastra} = makeMastraWith('generateQueryWorkflow', {
        status: 'success',
        result: {failed: {datasetId: '', sql: ''}},
      });
      const {events, writer} = captureWriter();

      const tool = new GetDataAsDatasetTool(mastra).build();
      const result = await executeFor(tool)(
        {prompt: 'list employees'},
        makeCtx(makeRc(writer)),
      );

      const last = events[events.length - 1] as {data: {status: ToolStatus}};
      expect(last.data.status).to.equal(ToolStatus.Failed);
      expect(result as string).to.match(/Could not generate/i);
    });

    it('emits AwaitingApproval and returns {} when the workflow is suspended (HITL pause)', async () => {
      // Hooked for the v3.1 ApprovalController path — the tool returns
      // an empty payload so the Agent loop pauses without injecting a
      // tool result the model would interpret as completion.
      const {mastra} = makeMastraWith('generateQueryWorkflow', {
        status: 'suspended',
      });
      const {events, writer} = captureWriter();

      const tool = new GetDataAsDatasetTool(mastra).build();
      const result = await executeFor(tool)(
        {prompt: 'x'},
        makeCtx(makeRc(writer)),
      );

      expect(result).to.eql({});
      const last = events[events.length - 1] as {data: {status: ToolStatus}};
      expect(last.data.status).to.equal(ToolStatus.AwaitingApproval);
    });

    it('throws (and emits Failed) when generateQueryWorkflow is not registered (provider misconfigured)', async () => {
      // Fail-loud guard: the tool depends on the Provider having wired
      // the workflow; without it the agent gets a typed runtime error.
      const getWorkflow = sinon.stub().returns(undefined);
      const mastra = {getWorkflow} as unknown as Mastra;
      const {events, writer} = captureWriter();

      const tool = new GetDataAsDatasetTool(mastra).build();
      await expect(
        executeFor(tool)({prompt: 'x'}, makeCtx(makeRc(writer))),
      ).to.be.rejectedWith(/generateQueryWorkflow not registered/);

      const last = events[events.length - 1] as {data: {status: ToolStatus}};
      expect(last.data.status).to.equal(ToolStatus.Failed);
    });

    it('throws (and emits Failed) when the workflow status is not success/suspended (e.g. failed/canceled)', async () => {
      const {mastra} = makeMastraWith('generateQueryWorkflow', {
        status: 'failed',
      });
      const {events, writer} = captureWriter();

      const tool = new GetDataAsDatasetTool(mastra).build();
      await expect(
        executeFor(tool)({prompt: 'x'}, makeCtx(makeRc(writer))),
      ).to.be.rejectedWith(/Query generation failed/);

      const last = events[events.length - 1] as {data: {status: ToolStatus}};
      expect(last.data.status).to.equal(ToolStatus.Failed);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // ImproveDatasetTool
  // ──────────────────────────────────────────────────────────────

  describe('ImproveDatasetTool', () => {
    it('unwraps the `save-improved` branch and emits Completed with the improved datasetId', async () => {
      // Different branch arm key than GetDataAsDatasetTool — improve's
      // success arm is `save-improved`.
      const {mastra, getWorkflow} = makeMastraWith('improveQueryWorkflow', {
        status: 'success',
        result: {
          [DbQueryNodes.SaveImproved]: {
            datasetId: 'ds-improved',
            sql: 'SELECT 2',
          },
        },
      });
      const {events, writer} = captureWriter();

      const tool = new ImproveDatasetTool(mastra).build();
      const result = await executeFor(tool)(
        {datasetId: 'ds-orig', prompt: 'add region column'},
        makeCtx(makeRc(writer), 'call-7'),
      );

      sinon.assert.calledOnceWithExactly(getWorkflow, 'improveQueryWorkflow');
      const toolEvt = events.find(
        e => e.type === LLMStreamEventType.Tool,
      ) as unknown as {
        data: {data: {datasetId: string; sql: string}};
      };
      expect(toolEvt.data.data).to.eql({
        datasetId: 'ds-improved',
        sql: 'SELECT 2',
      });
      expect(result as string).to.match(/Dataset updated/i);
    });

    it('falls back to the `failed` arm and returns the "could not update" readout', async () => {
      const {mastra} = makeMastraWith('improveQueryWorkflow', {
        status: 'success',
        result: {failed: {datasetId: '', sql: ''}},
      });
      const {events, writer} = captureWriter();

      const tool = new ImproveDatasetTool(mastra).build();
      const result = await executeFor(tool)(
        {datasetId: 'ds-orig', prompt: 'x'},
        makeCtx(makeRc(writer)),
      );

      const last = events[events.length - 1] as {data: {status: ToolStatus}};
      expect(last.data.status).to.equal(ToolStatus.Failed);
      expect(result as string).to.match(/Could not update/i);
    });

    it('throws when improveQueryWorkflow is not registered', async () => {
      const getWorkflow = sinon.stub().returns(undefined);
      const mastra = {getWorkflow} as unknown as Mastra;
      const {writer} = captureWriter();

      const tool = new ImproveDatasetTool(mastra).build();
      await expect(
        executeFor(tool)(
          {datasetId: 'ds-orig', prompt: 'x'},
          makeCtx(makeRc(writer)),
        ),
      ).to.be.rejectedWith(/improveQueryWorkflow not registered/);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // GenerateVisualizationTool
  // ──────────────────────────────────────────────────────────────

  describe('GenerateVisualizationTool', () => {
    it('emits a Tool event carrying visualization + config + datasetId (NOT existingDatasetId) so a live chart auto-renders', async () => {
      // The UI binds `visualization` to the chart-type enum and `config`
      // to the chart settings — both must be on `data.data`. `existingDatasetId`
      // is the history/re-run marker (the "Load Dataset" button), so it must be
      // ABSENT on a live turn or the UI won't auto-render the chart.
      const {mastra} = makeMastraWith('visualizationWorkflow', {
        status: 'success',
        result: {
          visualization: 'bar',
          chartConfig: {type: 'bar', options: {x: 'name'}},
          datasetId: 'ds-1',
          sql: 'SELECT 1',
          description: 'sales',
        },
      });
      const {events, writer} = captureWriter();

      const tool = new GenerateVisualizationTool(mastra).build();
      await executeFor(tool)(
        {prompt: 'sales by region', datasetId: 'ds-1', type: 'bar'},
        makeCtx(makeRc(writer), 'call-9'),
      );

      const toolEvt = events.find(
        e => e.type === LLMStreamEventType.Tool,
      ) as unknown as {
        data: {
          tool: string;
          data: {
            visualization: string;
            config: unknown;
            datasetId: string;
            existingDatasetId?: string;
            sql: string;
            description: string;
          };
        };
      };
      expect(toolEvt.data.tool).to.equal('generate-visualization');
      expect(toolEvt.data.data.visualization).to.equal('bar');
      expect(toolEvt.data.data.config).to.eql({
        type: 'bar',
        options: {x: 'name'},
      });
      expect(toolEvt.data.data.datasetId).to.equal('ds-1');
      expect(toolEvt.data.data.existingDatasetId).to.be.undefined();
      expect(toolEvt.data.data.sql).to.equal('SELECT 1');
      expect(toolEvt.data.data.description).to.equal('sales');

      const last = events[events.length - 1] as {data: {status: ToolStatus}};
      expect(last.data.status).to.equal(ToolStatus.Completed);
    });

    it('forwards datasetId="" and type=undefined when the agent omits them (auto-pick path)', async () => {
      const {mastra, start} = makeMastraWith('visualizationWorkflow', {
        status: 'success',
        result: {chartConfig: {}, visualization: 'bar', datasetId: 'fresh'},
      });
      const {writer} = captureWriter();

      const tool = new GenerateVisualizationTool(mastra).build();
      await executeFor(tool)(
        {prompt: 'revenue trend'},
        makeCtx(makeRc(writer)),
      );

      const startArgs = start.firstCall.args[0] as {
        inputData: {datasetId: string; userQuery: string; type?: string};
      };
      // The tool MUST coerce a missing datasetId to '' so the workflow's
      // `needsQuery=!datasetId` predicate fires.
      expect(startArgs.inputData.datasetId).to.equal('');
      expect(startArgs.inputData.userQuery).to.equal('revenue trend');
      expect(startArgs.inputData.type).to.be.undefined();
    });

    it('emits AwaitingApproval and returns {} when the workflow is suspended', async () => {
      const {mastra} = makeMastraWith('visualizationWorkflow', {
        status: 'suspended',
      });
      const {events, writer} = captureWriter();

      const tool = new GenerateVisualizationTool(mastra).build();
      const result = await executeFor(tool)(
        {prompt: 'q'},
        makeCtx(makeRc(writer)),
      );

      expect(result).to.eql({});
      const last = events[events.length - 1] as {data: {status: ToolStatus}};
      expect(last.data.status).to.equal(ToolStatus.AwaitingApproval);
    });

    it('throws when visualizationWorkflow is not registered', async () => {
      const getWorkflow = sinon.stub().returns(undefined);
      const mastra = {getWorkflow} as unknown as Mastra;
      const {writer} = captureWriter();

      const tool = new GenerateVisualizationTool(mastra).build();
      await expect(
        executeFor(tool)({prompt: 'q'}, makeCtx(makeRc(writer))),
      ).to.be.rejectedWith(/visualizationWorkflow not registered/);
    });
  });
});

import {expect, sinon} from '@loopback/testlab';
import {LLMProvider} from '../../../../types';
import {
  IMastraVisualizer,
  MastraVisualizationContext,
  MastraVisualizationState,
} from '../../../../mastra/visualization/types/visualization.types';
import {selectVisualizationStep} from '../../../../mastra/visualization/workflow/steps/select-visualization.step';
import {renderVisualizationStep} from '../../../../mastra/visualization/workflow/steps/render-visualization.step';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

function makeVisualizer(name: string): IMastraVisualizer {
  return {
    name,
    description: `A ${name} chart`,
    getConfig: sinon.stub().resolves({key: `${name}-config`}),
  };
}

describe('selectVisualizationStep (Mastra)', function () {
  let barViz: IMastraVisualizer;
  let lineViz: IMastraVisualizer;
  let pieViz: IMastraVisualizer;
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraVisualizationContext;

  const baseState = {
    prompt: 'Show employee count by department',
    sql: 'SELECT dept, COUNT(*) FROM employees GROUP BY dept',
    queryDescription: 'Employee count per department',
  } as unknown as MastraVisualizationState;

  beforeEach(() => {
    barViz = makeVisualizer('bar');
    lineViz = makeVisualizer('line');
    pieViz = makeVisualizer('pie');
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  describe('fast-path (explicit type)', function () {
    it('resolves explicit type without calling LLM', async () => {
      const state = {
        ...baseState,
        type: 'bar',
      } as unknown as MastraVisualizationState;

      const result = await selectVisualizationStep(state, context, {
        llm: createFakeLanguageModel('bar') as unknown as LLMProvider,
        visualizers: [barViz, lineViz, pieViz],
      });

      expect(result.visualizer).to.equal(barViz);
      expect(result.visualizerName).to.equal('bar');
      sinon.assert.notCalled(onUsageSpy);
    });

    it('throws when explicit type is unknown', async () => {
      const state = {
        ...baseState,
        type: 'heatmap',
      } as unknown as MastraVisualizationState;

      await expect(
        selectVisualizationStep(state, context, {
          llm: createFakeLanguageModel('bar') as unknown as LLMProvider,
          visualizers: [barViz],
        }),
      ).to.be.rejectedWith(/No visualizer found with name "heatmap"/);
    });
  });

  describe('LLM-selection path', function () {
    it('returns visualizer matching LLM output', async () => {
      const result = await selectVisualizationStep(baseState, context, {
        llm: createFakeLanguageModel('bar') as unknown as LLMProvider,
        visualizers: [barViz, lineViz, pieViz],
      });

      expect(result.visualizer).to.equal(barViz);
      expect(result.visualizerName).to.equal('bar');
      sinon.assert.calledOnce(onUsageSpy);
    });

    it('returns error object when LLM says none', async () => {
      const result = await selectVisualizationStep(baseState, context, {
        llm: createFakeLanguageModel(
          'none: data has too many dimensions',
        ) as unknown as LLMProvider,
        visualizers: [barViz, lineViz, pieViz],
      });

      expect(result.error).to.match(/data has too many dimensions/);
      expect(result.visualizer).to.be.undefined();
    });

    it('throws when LLM returns unknown visualizer name', async () => {
      await expect(
        selectVisualizationStep(baseState, context, {
          llm: createFakeLanguageModel('scatter') as unknown as LLMProvider,
          visualizers: [barViz],
        }),
      ).to.be.rejectedWith(/LLM returned unknown visualizer "scatter"/);
    });
  });
});

describe('renderVisualizationStep (Mastra)', function () {
  let barViz: IMastraVisualizer;
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraVisualizationContext;

  const baseState = {
    prompt: 'Show employee count',
    sql: 'SELECT dept, COUNT(*) FROM employees GROUP BY dept',
    queryDescription: 'Employee count per department',
    datasetId: '42',
    visualizerName: 'bar',
  } as unknown as MastraVisualizationState;

  beforeEach(() => {
    barViz = makeVisualizer('bar');
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  it('calls visualizer.getConfig() and returns done=true', async () => {
    const state = {
      ...baseState,
      visualizer: barViz,
    } as unknown as MastraVisualizationState;

    const result = await renderVisualizationStep(state, context, {});

    expect(result.done).to.be.true();
    expect(result.visualizerConfig).to.deepEqual({key: 'bar-config'});
    sinon.assert.calledOnce(barViz.getConfig as sinon.SinonStub);
  });

  it('passes context.onUsage to visualizer.getConfig()', async () => {
    const state = {
      ...baseState,
      visualizer: barViz,
    } as unknown as MastraVisualizationState;

    await renderVisualizationStep(state, context, {});

    const call = (barViz.getConfig as sinon.SinonStub).firstCall;
    expect(call.args[1]).to.equal(onUsageSpy);
  });

  it('throws when visualizer is missing from state', async () => {
    const state = {
      ...baseState,
      visualizer: undefined,
    } as unknown as MastraVisualizationState;

    await expect(
      renderVisualizationStep(state, context, {}),
    ).to.be.rejectedWith(
      /visualizer, sql, and queryDescription are all required/,
    );
  });

  it('throws when sql is missing from state', async () => {
    const state = {
      ...baseState,
      visualizer: barViz,
      sql: undefined,
    } as unknown as MastraVisualizationState;

    await expect(
      renderVisualizationStep(state, context, {}),
    ).to.be.rejectedWith(
      /visualizer, sql, and queryDescription are all required/,
    );
  });
});

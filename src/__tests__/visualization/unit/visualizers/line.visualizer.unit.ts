import {expect, sinon} from '@loopback/testlab';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {fail} from 'assert';
import {LineVisualizer} from '../../../../components/visualization/visualizers/line.visualizer';
import * as llmHelpers from '../../../../mastra/workflows/db-query/llm-helpers';

describe('LineVisualizer Unit', function () {
  let visualizer: LineVisualizer;
  let llm: MastraLanguageModel;
  let invokeLlmObjectStub: sinon.SinonStub;

  beforeEach(() => {
    llm = {} as MastraLanguageModel;
    visualizer = new LineVisualizer(llm);
    invokeLlmObjectStub = sinon.stub(llmHelpers, 'invokeLlmObject');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should have correct name and description', () => {
    expect(visualizer.name).to.equal('line');
    expect(visualizer.description).to.match(/line chart/);
    expect(visualizer.description).to.match(/trends/);
    expect(visualizer.description).to.match(/time/);
  });

  it('should have valid schema with required fields', () => {
    const result = visualizer.schema.safeParse({
      xAxisColumn: 'date',
      yAxisColumn: 'value',
      seriesColumns: 'category',
    });

    expect(result.success).to.be.true();
  });

  it('should accept empty string seriesColumn', () => {
    const result = visualizer.schema.safeParse({
      xAxisColumn: 'date',
      yAxisColumn: 'value',
      seriesColumns: '',
    });

    expect(result.success).to.be.true();
  });

  it('should reject missing seriesColumn field', () => {
    const result = visualizer.schema.safeParse({
      xAxisColumn: 'date',
      yAxisColumn: 'value',
    });

    expect(result.success).to.be.false();
  });

  it('should reject missing required fields', () => {
    expect(
      visualizer.schema.safeParse({
        yAxisColumn: 'value',
        seriesColumn: 'category',
      }).success,
    ).to.be.false();

    expect(
      visualizer.schema.safeParse({
        xAxisColumn: 'date',
        seriesColumn: 'category',
      }).success,
    ).to.be.false();
  });

  it('should throw error when state is invalid (missing sql)', async () => {
    try {
      await visualizer.getConfig({
        prompt: 'test prompt',
        datasetId: 'test-id',
        queryDescription: 'test description',
      });
      fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.have.property('message', 'Invalid State');
    }
  });

  it('should throw error when state is invalid (missing queryDescription)', async () => {
    try {
      await visualizer.getConfig({
        prompt: 'test prompt',
        datasetId: 'test-id',
        sql: 'SELECT * FROM test',
      });
      fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.have.property('message', 'Invalid State');
    }
  });

  it('should throw error when state is invalid (missing prompt)', async () => {
    try {
      await visualizer.getConfig({
        datasetId: 'test-id',
        sql: 'SELECT * FROM test',
        queryDescription: 'test description',
      });
      fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.have.property('message', 'Invalid State');
    }
  });

  it('should successfully generate config with valid state', async () => {
    const mockLLMResponse = {
      xAxisColumn: 'month',
      yAxisColumn: 'revenue',
      seriesColumns: 'product_line',
    };

    invokeLlmObjectStub.resolves(mockLLMResponse);

    const input = {
      prompt:
        'Show me a line chart of revenue trends over time by product line',
      datasetId: 'test-dataset',
      sql: 'SELECT month, product_line, SUM(revenue) as revenue FROM sales GROUP BY month, product_line',
      queryDescription: 'Revenue trends by product line over time',
    };

    const config = await visualizer.getConfig(input);

    expect(config).to.deepEqual({
      ...mockLLMResponse,
      seriesColumns: ['product_line'],
    });
    expect(invokeLlmObjectStub.calledOnce).to.be.true();

    const [modelArg, , schemaArg, optionsArg] =
      invokeLlmObjectStub.getCall(0).args;
    expect(modelArg).to.equal(llm);
    expect(schemaArg).to.equal(visualizer.schema);
    expect(optionsArg).to.deepEqual({
      requestContext: undefined,
      functionId: 'visualization.line.config',
    });
  });

  it('should successfully generate config without series column', async () => {
    invokeLlmObjectStub.resolves({
      xAxisColumn: 'month',
      yAxisColumn: 'total_sales',
      seriesColumns: null,
    });

    const config = await visualizer.getConfig({
      prompt: 'Show me total sales over time',
      datasetId: 'test-dataset',
      sql: 'SELECT month, SUM(sales) as total_sales FROM sales GROUP BY month',
      queryDescription: 'Total sales over time',
    });

    expect(config).to.deepEqual({
      xAxisColumn: 'month',
      yAxisColumn: 'total_sales',
      seriesColumns: null,
    });
  });

  it('should handle LLM errors gracefully', async () => {
    const mockError = new Error('LLM processing failed');
    invokeLlmObjectStub.rejects(mockError);

    try {
      await visualizer.getConfig({
        prompt: 'test prompt',
        datasetId: 'test-dataset',
        sql: 'SELECT * FROM test',
        queryDescription: 'test description',
      });
      fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.equal(mockError);
    }
  });

  it('should contain proper prompt template structure', () => {
    const templateText = visualizer.renderPrompt.template;
    expect(templateText).to.match(/line chart/);
    expect(templateText).to.match(/\{sql\}/);
    expect(templateText).to.match(/\{description\}/);
    expect(templateText).to.match(/\{userPrompt\}/);
    expect(templateText).to.match(/x-axis/);
    expect(templateText).to.match(/y-axis/);
    expect(templateText).to.match(/multiple series/);
  });
});

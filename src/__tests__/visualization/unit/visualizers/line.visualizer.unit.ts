import {expect, sinon} from '@loopback/testlab';
import {LineVisualizer} from '../../../../components/visualization/visualizers/line.visualizer';
import {fail} from 'assert';
import {VisualizationGraphState} from '../../../../components';
describe('LineVisualizer Unit', function () {
  let visualizer: LineVisualizer;
  let generateObjectStub: sinon.SinonStub;

  beforeEach(() => {
    // Constructor: (smartNonThinkingModel optional, chatModel). Pass
    // undefined for the optional tier slot so the chat-model fallback
    // path is exercised — matches what the test exercised before tier
    // wiring (when the visualizer only knew about ChatLLM).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visualizer = new LineVisualizer(undefined, {} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateObjectStub = sinon.stub(visualizer, 'callGen' as any);
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
    const schema = visualizer.schema;
    expect(schema).to.be.ok();

    // Test schema structure by trying to parse valid data
    const validData = {
      xAxisColumn: 'date',
      yAxisColumn: 'value',
      seriesColumns: 'category',
    };

    const result = schema.safeParse(validData);
    expect(result.success).to.be.true();

    if (result.success) {
      expect(result.data).to.deepEqual(validData);
    }
  });

  it('should accept empty string seriesColumn', () => {
    const schema = visualizer.schema;
    const dataWithNullSeries = {
      xAxisColumn: 'date',
      yAxisColumn: 'value',
      seriesColumns: '',
    };

    const result = schema.safeParse(dataWithNullSeries);
    expect(result.success).to.be.true();
  });

  it('should reject missing seriesColumn field', () => {
    const schema = visualizer.schema;
    const dataWithoutSeries = {
      xAxisColumn: 'date',
      yAxisColumn: 'value',
    };

    const result = schema.safeParse(dataWithoutSeries);
    // seriesColumn is nullable but still required - omitting it should fail
    expect(result.success).to.be.false();
  });

  it('should reject missing required fields', () => {
    const schema = visualizer.schema;

    // Missing xAxisColumn
    const missingXAxis = {
      yAxisColumn: 'value',
      seriesColumn: 'category',
    };
    expect(schema.safeParse(missingXAxis).success).to.be.false();

    // Missing yAxisColumn
    const missingYAxis = {
      xAxisColumn: 'date',
      seriesColumn: 'category',
    };
    expect(schema.safeParse(missingYAxis).success).to.be.false();
  });

  it('should throw error when state is invalid (missing sql)', async () => {
    const invalidState = {
      prompt: 'test prompt',
      datasetId: 'test-id',
      queryDescription: 'test description',
      // sql is missing - will be undefined
    } as unknown as VisualizationGraphState;

    try {
      await visualizer.getConfig(invalidState);
      fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.have.property('message', 'Invalid State');
    }
  });

  it('should throw error when state is invalid (missing queryDescription)', async () => {
    const invalidState = {
      prompt: 'test prompt',
      datasetId: 'test-id',
      sql: 'SELECT * FROM test',
      // queryDescription is missing - will be undefined
    } as unknown as VisualizationGraphState;

    try {
      await visualizer.getConfig(invalidState);
      fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.have.property('message', 'Invalid State');
    }
  });

  it('should throw error when state is invalid (missing prompt)', async () => {
    const invalidState = {
      datasetId: 'test-id',
      sql: 'SELECT * FROM test',
      queryDescription: 'test description',
      // prompt is missing - will be undefined
    } as unknown as VisualizationGraphState;

    try {
      await visualizer.getConfig(invalidState);
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

    generateObjectStub.resolves({object: mockLLMResponse});

    const validState = {
      prompt:
        'Show me a line chart of revenue trends over time by product line',
      datasetId: 'test-dataset',
      sql: 'SELECT month, product_line, SUM(revenue) as revenue FROM sales GROUP BY month, product_line',
      queryDescription: 'Revenue trends by product line over time',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    expect(config.xAxisColumn).to.equal('month');
    expect(config.yAxisColumn).to.equal('revenue');
    expect(generateObjectStub.calledOnce).to.be.true();

    // Check that generateObject was called with a prompt containing our data
    const callArgs = generateObjectStub.getCall(0).args[0];
    expect(callArgs.prompt).to.match(/<sql>/);
    expect(callArgs.prompt).to.match(/<description>/);
    expect(callArgs.prompt).to.match(/<user-prompt>/);
    // Escape special regex characters in SQL
    const escapedSQL = validState.sql?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(callArgs.prompt).to.match(new RegExp(escapedSQL ?? ''));
    expect(callArgs.prompt).to.match(
      new RegExp(validState.queryDescription ?? ''),
    );
    expect(callArgs.prompt).to.match(new RegExp(validState.prompt));
  });

  it('should successfully generate config without series column', async () => {
    generateObjectStub.resolves({
      object: {
        xAxisColumn: 'month',
        yAxisColumn: 'total_sales',
        seriesColumns: null,
      },
    });

    const validState = {
      prompt: 'Show me total sales over time',
      datasetId: 'test-dataset',
      sql: 'SELECT month, SUM(sales) as total_sales FROM sales GROUP BY month',
      queryDescription: 'Total sales over time',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    expect(config.xAxisColumn).to.equal('month');
    expect(config.yAxisColumn).to.equal('total_sales');
    expect(config.seriesColumns).to.be.null();
  });

  it('should handle LLM errors gracefully', async () => {
    const mockError = new Error('LLM processing failed');
    generateObjectStub.rejects(mockError);

    const validState = {
      prompt: 'test prompt',
      datasetId: 'test-dataset',
      sql: 'SELECT * FROM test',
      queryDescription: 'test description',
    } as unknown as VisualizationGraphState;

    try {
      await visualizer.getConfig(validState);
      fail('Should have thrown an error');
    } catch (error) {
      expect(error).to.equal(mockError);
    }
  });

  it('should contain proper prompt template structure', async () => {
    generateObjectStub.resolves({
      object: {
        xAxisColumn: 'date',
        yAxisColumn: 'value',
        seriesColumns: '',
      },
    });

    const validState = {
      prompt: 'test prompt',
      datasetId: 'test-dataset',
      sql: 'SELECT * FROM test',
      queryDescription: 'test description',
    } as unknown as VisualizationGraphState;

    await visualizer.getConfig(validState);

    const callArgs = generateObjectStub.getCall(0).args[0];
    const promptText: string = callArgs.prompt;
    expect(promptText).to.match(/line chart/);
    expect(promptText).to.match(/<sql>/);
    expect(promptText).to.match(/<description>/);
    expect(promptText).to.match(/<user-prompt>/);
    expect(promptText).to.match(/x-axis/);
    expect(promptText).to.match(/y-axis/);
    expect(promptText).to.match(/multiple series/);
  });
});

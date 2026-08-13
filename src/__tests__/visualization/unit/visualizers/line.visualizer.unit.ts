import {expect} from '@loopback/testlab';
import {fail} from 'assert';
import {LineVisualizer} from '../../../../components/visualization/visualizers/line.visualizer';
import {VisualizationGraphState} from '../../../../components';
import {LlmService} from '../../../../services/llm.service';
import {createMockLLM, MockLLM} from '../../../test-helper';

describe('LineVisualizer Unit', function () {
  let visualizer: LineVisualizer;
  let llm: MockLLM;

  beforeEach(() => {
    llm = createMockLLM();
    visualizer = new LineVisualizer(new LlmService(), llm.model);
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
    // The visualizer now calls the AI SDK `generateObject`; the fake model
    // returns the structured config as JSON text which `generateObject` parses.
    llm.setText(
      JSON.stringify({
        xAxisColumn: 'month',
        yAxisColumn: 'revenue',
        seriesColumns: 'product_line',
      }),
    );

    const validState = {
      prompt:
        'Show me a line chart of revenue trends over time by product line',
      datasetId: 'test-dataset',
      sql: 'SELECT month, product_line, SUM(revenue) as revenue FROM sales GROUP BY month, product_line',
      queryDescription: 'Revenue trends by product line over time',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    // getConfig normalises the comma-separated seriesColumns into an array.
    expect(config).to.deepEqual({
      xAxisColumn: 'month',
      yAxisColumn: 'revenue',
      seriesColumns: ['product_line'],
    });
    expect(llm.calls).to.equal(1);

    // Check that the rendered prompt contained our data
    const promptText = llm.prompts[0];
    // Escape special regex characters in SQL
    const escapedSQL = validState.sql?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(promptText).to.match(new RegExp(escapedSQL ?? ''));
    expect(promptText).to.match(new RegExp(validState.queryDescription ?? ''));
    expect(promptText).to.match(new RegExp(validState.prompt));
  });

  it('should successfully generate config without series column', async () => {
    // The new schema requires `seriesColumns` to be a string; "no series" is
    // represented by an empty string (previously the LLM stub could return
    // null, which the AI SDK `generateObject` schema no longer accepts). The
    // visualizer then normalises an empty seriesColumns back to null.
    llm.setText(
      JSON.stringify({
        xAxisColumn: 'month',
        yAxisColumn: 'total_sales',
        seriesColumns: '',
      }),
    );

    const validState = {
      prompt: 'Show me total sales over time',
      datasetId: 'test-dataset',
      sql: 'SELECT month, SUM(sales) as total_sales FROM sales GROUP BY month',
      queryDescription: 'Total sales over time',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    expect(config).to.deepEqual({
      xAxisColumn: 'month',
      yAxisColumn: 'total_sales',
      seriesColumns: null,
    });
    expect(config.seriesColumns).to.be.null();
  });

  it('should handle LLM errors gracefully', async () => {
    const mockError = new Error('LLM processing failed');
    llm.rejectWith(mockError);

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
      expect(error).to.have.property('message', 'LLM processing failed');
    }
  });

  it('should contain proper prompt template structure', () => {
    const templateText = visualizer.renderPrompt;
    expect(templateText).to.be.ok();

    expect(templateText).to.match(/line chart/);
    expect(templateText).to.match(/\{sql\}/);
    expect(templateText).to.match(/\{description\}/);
    expect(templateText).to.match(/\{userPrompt\}/);
    expect(templateText).to.match(/x-axis/);
    expect(templateText).to.match(/y-axis/);
    expect(templateText).to.match(/multiple series/);
  });
});

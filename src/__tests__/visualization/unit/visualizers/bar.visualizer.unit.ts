import {expect} from '@loopback/testlab';
import {fail} from 'assert';
import {BarVisualizer} from '../../../../components/visualization/visualizers/bar.visualizer';
import {VisualizationGraphState} from '../../../../components';
import {createMockLLM, MockLLM} from '../../../test-helper';

describe('BarVisualizer Unit', function () {
  let visualizer: BarVisualizer;
  let llm: MockLLM;

  beforeEach(() => {
    llm = createMockLLM();
    visualizer = new BarVisualizer(llm.model);
  });

  it('should have correct name and description', () => {
    expect(visualizer.name).to.equal('bar');
    expect(visualizer.description).to.match(/bar chart/);
    expect(visualizer.description).to.match(/comparing values/);
  });

  it('should have valid schema with required fields', () => {
    const schema = visualizer.schema;
    expect(schema).to.be.ok();

    // Test schema structure by trying to parse valid data
    const validData = {
      categoryColumn: 'category',
      valueColumn: 'value',
      orientation: 'vertical',
    };

    const result = schema.safeParse(validData);
    expect(result.success).to.be.true();

    if (result.success) {
      expect(result.data).to.deepEqual(validData);
    }
  });

  it('should validate schema with default orientation', () => {
    const schema = visualizer.schema;
    const dataWithoutOrientation = {
      categoryColumn: 'category',
      valueColumn: 'value',
    };

    const result = schema.safeParse(dataWithoutOrientation);
    expect(result.success).to.be.true();

    if (result.success) {
      expect((result.data as {orientation: string}).orientation).to.equal(
        'vertical',
      );
    }
  });

  it('should reject invalid orientation values', () => {
    const schema = visualizer.schema;
    const invalidData = {
      categoryColumn: 'category',
      valueColumn: 'value',
      orientation: 42, // invalid type
    };

    const result = schema.safeParse(invalidData);
    expect(result.success).to.be.false();
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
      categoryColumn: 'department',
      valueColumn: 'salary',
      orientation: 'vertical',
    };

    // The visualizer now calls the AI SDK `generateObject`; the fake model
    // returns the structured config as JSON text which `generateObject` parses.
    llm.setText(JSON.stringify(mockLLMResponse));

    const validState = {
      prompt: 'Show me a bar chart of salaries by department',
      datasetId: 'test-dataset',
      sql: 'SELECT department, AVG(salary) as avg_salary FROM employees GROUP BY department',
      queryDescription: 'Average salary by department',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    expect(config).to.deepEqual(mockLLMResponse);
    expect(llm.calls).to.equal(1);

    // Check that the rendered prompt contained our data
    const promptText = llm.prompts[0];
    // Escape special regex characters in SQL
    const escapedSQL =
      validState.sql?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    expect(promptText).to.match(new RegExp(escapedSQL));
    expect(promptText).to.match(new RegExp(validState.queryDescription ?? ''));
    expect(promptText).to.match(new RegExp(validState.prompt));
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

    expect(templateText).to.match(/bar chart/);
    expect(templateText).to.match(/\{sql\}/);
    expect(templateText).to.match(/\{description\}/);
    expect(templateText).to.match(/\{userPrompt\}/);
    expect(templateText).to.match(/x-axis/);
    expect(templateText).to.match(/y-axis/);
  });
});

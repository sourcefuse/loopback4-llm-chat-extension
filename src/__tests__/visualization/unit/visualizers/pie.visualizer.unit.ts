import {expect} from '@loopback/testlab';
import {fail} from 'assert';
import {PieVisualizer} from '../../../../components/visualization/visualizers/pie.visualizer';
import {VisualizationGraphState} from '../../../../components';
import {createMockLLM, MockLLM} from '../../../test-helper';

describe('PieVisualizer Unit', function () {
  let visualizer: PieVisualizer;
  let llm: MockLLM;

  beforeEach(() => {
    llm = createMockLLM();
    visualizer = new PieVisualizer(llm.model);
  });

  it('should have correct name and description', () => {
    expect(visualizer.name).to.equal('pie');
    expect(visualizer.description).to.match(/pie chart/);
    expect(visualizer.description).to.match(/proportions/);
    expect(visualizer.description).to.match(/percentages/);
  });

  it('should have valid schema with required fields', () => {
    const schema = visualizer.schema;
    expect(schema).to.be.ok();

    // Test schema structure by trying to parse valid data
    const validData = {
      labelColumn: 'category',
      valueColumn: 'amount',
    };

    const result = schema.safeParse(validData);
    expect(result.success).to.be.true();

    if (result.success) {
      expect(result.data).to.deepEqual(validData);
    }
  });

  it('should reject missing required fields', () => {
    const schema = visualizer.schema;

    // Missing labelColumn
    const missingLabel = {
      valueColumn: 'amount',
    };
    expect(schema.safeParse(missingLabel).success).to.be.false();

    // Missing valueColumn
    const missingValue = {
      labelColumn: 'category',
    };
    expect(schema.safeParse(missingValue).success).to.be.false();
  });

  it('should reject invalid field types', () => {
    const schema = visualizer.schema;

    // Non-string labelColumn
    const invalidLabel = {
      labelColumn: 123,
      valueColumn: 'amount',
    };
    expect(schema.safeParse(invalidLabel).success).to.be.false();

    // Non-string valueColumn
    const invalidValue = {
      labelColumn: 'category',
      valueColumn: 456,
    };
    expect(schema.safeParse(invalidValue).success).to.be.false();
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
      labelColumn: 'department',
      valueColumn: 'budget_allocation',
    };

    // The visualizer now calls the AI SDK `generateObject`; the fake model
    // returns the structured config as JSON text which `generateObject` parses.
    llm.setText(JSON.stringify(mockLLMResponse));

    const validState = {
      prompt: 'Show me a pie chart of budget allocation by department',
      datasetId: 'test-dataset',
      sql: 'SELECT department, SUM(budget) as budget_allocation FROM departments GROUP BY department',
      queryDescription: 'Budget allocation by department',
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

  it('should handle LLM response with percentage data', async () => {
    const mockLLMResponse = {
      labelColumn: 'product_category',
      valueColumn: 'sales_percentage',
    };

    llm.setText(JSON.stringify(mockLLMResponse));

    const validState = {
      prompt: 'Show me sales distribution by product category as percentages',
      datasetId: 'test-dataset',
      sql: 'SELECT product_category, (sales / total_sales * 100) as sales_percentage FROM sales_summary',
      queryDescription: 'Sales distribution by product category',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    expect(config).to.deepEqual(mockLLMResponse);
    expect(config.labelColumn).to.equal('product_category');
    expect(config.valueColumn).to.equal('sales_percentage');
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

    expect(templateText).to.match(/pie chart/);
    expect(templateText).to.match(/\{sql\}/);
    expect(templateText).to.match(/\{description\}/);
    expect(templateText).to.match(/\{userPrompt\}/);
    expect(templateText).to.match(/categories/);
  });

  it('should validate that schema describes columns correctly', () => {
    const schema = visualizer.schema;

    // Access the schema shape to check descriptions (zod v4 public API).
    const shape = (
      schema as unknown as {shape: Record<string, {description?: string}>}
    ).shape;

    expect(shape.labelColumn.description).to.match(/labels/);
    expect(shape.labelColumn.description).to.match(/pie chart/);
    expect(shape.valueColumn.description).to.match(/values/);
    expect(shape.valueColumn.description).to.match(/pie chart/);
  });
});

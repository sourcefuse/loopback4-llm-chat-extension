import {expect, sinon} from '@loopback/testlab';
import {BarVisualizer} from '../../../../components/visualization/visualizers/bar.visualizer';
import {fail} from 'assert';
import {VisualizationGraphState} from '../../../../components';
describe('BarVisualizer Unit', function () {
  let visualizer: BarVisualizer;
  let generateObjectStub: sinon.SinonStub;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    visualizer = new BarVisualizer({} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateObjectStub = sinon.stub(visualizer, 'callGen' as any);
  });

  afterEach(() => {
    sinon.restore();
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

  it('requires orientation (no default — OpenAI strict structured output rejects optional fields)', () => {
    const schema = visualizer.schema;
    // orientation is now a required field; omitting it must fail parse.
    // The `.default('vertical')` was removed because AI SDK marks a
    // defaulted field optional, which drops it from JSON-schema `required`
    // and makes generateObject 400 under OpenAI strict mode.
    const dataWithoutOrientation = {
      categoryColumn: 'category',
      valueColumn: 'value',
    };
    expect(schema.safeParse(dataWithoutOrientation).success).to.be.false();

    const dataWithOrientation = {
      categoryColumn: 'category',
      valueColumn: 'value',
      orientation: 'vertical',
    };
    const result = schema.safeParse(dataWithOrientation);
    expect(result.success).to.be.true();
    if (result.success) {
      expect(result.data.orientation).to.equal('vertical');
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

    generateObjectStub.resolves({object: mockLLMResponse});

    const validState = {
      prompt: 'Show me a bar chart of salaries by department',
      datasetId: 'test-dataset',
      sql: 'SELECT department, AVG(salary) as avg_salary FROM employees GROUP BY department',
      queryDescription: 'Average salary by department',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    expect(config).to.deepEqual(mockLLMResponse);
    expect(generateObjectStub.calledOnce).to.be.true();

    // Check that generateObject was called with a prompt containing our data
    const callArgs = generateObjectStub.getCall(0).args[0];
    expect(callArgs.prompt).to.match(/<sql>/);
    expect(callArgs.prompt).to.match(/<description>/);
    expect(callArgs.prompt).to.match(/<user-prompt>/);
    // Escape special regex characters in SQL
    const escapedSQL =
      validState.sql?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    expect(callArgs.prompt).to.match(new RegExp(escapedSQL));
    expect(callArgs.prompt).to.match(
      new RegExp(validState.queryDescription ?? ''),
    );
    expect(callArgs.prompt).to.match(new RegExp(validState.prompt));
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
        categoryColumn: 'category',
        valueColumn: 'value',
        orientation: 'vertical',
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
    expect(promptText).to.match(/bar chart/);
    expect(promptText).to.match(/<sql>/);
    expect(promptText).to.match(/<description>/);
    expect(promptText).to.match(/<user-prompt>/);
    expect(promptText).to.match(/x-axis/);
    expect(promptText).to.match(/y-axis/);
  });
});

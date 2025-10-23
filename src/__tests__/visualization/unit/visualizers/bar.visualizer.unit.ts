import {expect, sinon} from '@loopback/testlab';
import {BarVisualizer} from '../../../../components/visualization/visualizers/bar.visualizer';
import {LLMProvider} from '../../../../types';
import {fail} from 'assert';
import {VisualizationGraphState} from '../../../../components';

describe('BarVisualizer Unit', function () {
  let visualizer: BarVisualizer;
  let llmProvider: sinon.SinonStubbedInstance<LLMProvider>;
  let withStructuredOutputStub: sinon.SinonStub;

  beforeEach(() => {
    // Create stub for LLM provider
    withStructuredOutputStub = sinon.stub();
    llmProvider = {
      withStructuredOutput: withStructuredOutputStub,
    } as sinon.SinonStubbedInstance<LLMProvider>;

    visualizer = new BarVisualizer(llmProvider);
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

  it('should validate schema with default orientation', () => {
    const schema = visualizer.schema;
    const dataWithoutOrientation = {
      categoryColumn: 'category',
      valueColumn: 'value',
    };

    const result = schema.safeParse(dataWithoutOrientation);
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

    const mockInvoke = sinon.stub().resolves(mockLLMResponse);
    withStructuredOutputStub.returns(mockInvoke);

    const validState = {
      prompt: 'Show me a bar chart of salaries by department',
      datasetId: 'test-dataset',
      sql: 'SELECT department, AVG(salary) as avg_salary FROM employees GROUP BY department',
      queryDescription: 'Average salary by department',
    } as unknown as VisualizationGraphState;

    const config = await visualizer.getConfig(validState);

    expect(config).to.deepEqual(mockLLMResponse);
    expect(
      withStructuredOutputStub.calledOnceWith(visualizer.schema),
    ).to.be.true();
    expect(mockInvoke.calledOnce).to.be.true();

    // Check that the mock was called with a StringPromptValue containing our data
    const invokeArgs = mockInvoke.getCall(0).args[0];
    expect(invokeArgs).to.have.property('value');
    // Escape special regex characters in SQL
    const escapedSQL =
      validState.sql?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    expect(invokeArgs.value).to.match(new RegExp(escapedSQL));
    expect(invokeArgs.value).to.match(
      new RegExp(validState.queryDescription ?? ''),
    );
    expect(invokeArgs.value).to.match(new RegExp(validState.prompt));
  });

  it('should handle LLM errors gracefully', async () => {
    const mockError = new Error('LLM processing failed');
    const mockInvoke = sinon.stub().rejects(mockError);
    withStructuredOutputStub.returns(mockInvoke);

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

  it('should contain proper prompt template structure', () => {
    const promptTemplate = visualizer.renderPrompt;
    expect(promptTemplate).to.be.ok();

    const templateText = promptTemplate.template;
    expect(templateText).to.match(/bar chart/);
    expect(templateText).to.match(/\{sql\}/);
    expect(templateText).to.match(/\{description\}/);
    expect(templateText).to.match(/\{userPrompt\}/);
    expect(templateText).to.match(/x-axis/);
    expect(templateText).to.match(/y-axis/);
  });
});

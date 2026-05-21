import {expect, sinon} from '@loopback/testlab';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {fail} from 'assert';
import {BarVisualizer} from '../../../../components/visualization/visualizers/bar.visualizer';
import * as llmHelpers from '../../../../mastra/workflows/db-query/llm-helpers';

describe('BarVisualizer Unit', function () {
  let visualizer: BarVisualizer;
  let llm: MastraLanguageModel;
  let invokeLlmObjectStub: sinon.SinonStub;

  beforeEach(() => {
    llm = {} as MastraLanguageModel;
    visualizer = new BarVisualizer(llm);
    invokeLlmObjectStub = sinon.stub(llmHelpers, 'invokeLlmObject');
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
    const result = visualizer.schema.safeParse({
      categoryColumn: 'category',
      valueColumn: 'value',
    });

    expect(result.success).to.be.true();

    if (result.success) {
      expect(result.data.orientation).to.equal('vertical');
    }
  });

  it('should reject invalid orientation values', () => {
    const result = visualizer.schema.safeParse({
      categoryColumn: 'category',
      valueColumn: 'value',
      orientation: 42,
    });

    expect(result.success).to.be.false();
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
      categoryColumn: 'department',
      valueColumn: 'salary',
      orientation: 'vertical',
    };
    invokeLlmObjectStub.resolves(mockLLMResponse);

    const input = {
      prompt: 'Show me a bar chart of salaries by department',
      datasetId: 'test-dataset',
      sql: 'SELECT department, AVG(salary) as avg_salary FROM employees GROUP BY department',
      queryDescription: 'Average salary by department',
    };

    const config = await visualizer.getConfig(input);

    expect(config).to.deepEqual(mockLLMResponse);
    expect(invokeLlmObjectStub.calledOnce).to.be.true();

    const [modelArg, promptArg, schemaArg, optionsArg] =
      invokeLlmObjectStub.getCall(0).args;
    expect(modelArg).to.equal(llm);
    expect(schemaArg).to.equal(visualizer.schema);
    expect(optionsArg).to.deepEqual({
      requestContext: undefined,
      functionId: 'visualization.bar.config',
    });

    expect(promptArg).to.match(
      new RegExp(input.sql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    expect(promptArg).to.match(new RegExp(input.queryDescription));
    expect(promptArg).to.match(new RegExp(input.prompt));
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

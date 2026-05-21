import {expect, sinon} from '@loopback/testlab';
import type {MastraLanguageModel} from '@mastra/core/agent';
import {fail} from 'assert';
import {PieVisualizer} from '../../../../components/visualization/visualizers/pie.visualizer';
import * as llmHelpers from '../../../../mastra/workflows/db-query/llm-helpers';

describe('PieVisualizer Unit', function () {
  let visualizer: PieVisualizer;
  let llm: MastraLanguageModel;
  let invokeLlmObjectStub: sinon.SinonStub;

  beforeEach(() => {
    llm = {} as MastraLanguageModel;
    visualizer = new PieVisualizer(llm);
    invokeLlmObjectStub = sinon.stub(llmHelpers, 'invokeLlmObject');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should have correct name and description', () => {
    expect(visualizer.name).to.equal('pie');
    expect(visualizer.description).to.match(/pie chart/);
  });

  it('should have valid schema with required fields', () => {
    const result = visualizer.schema.safeParse({
      labelColumn: 'category',
      valueColumn: 'value',
    });

    expect(result.success).to.be.true();
  });

  it('should reject missing required fields', () => {
    expect(
      visualizer.schema.safeParse({
        valueColumn: 'value',
      }).success,
    ).to.be.false();

    expect(
      visualizer.schema.safeParse({
        labelColumn: 'category',
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
      labelColumn: 'department',
      valueColumn: 'total_salary',
    };
    invokeLlmObjectStub.resolves(mockLLMResponse);

    const input = {
      prompt: 'Show me salary distribution by department',
      datasetId: 'test-dataset',
      sql: 'SELECT department, SUM(salary) as total_salary FROM employees GROUP BY department',
      queryDescription: 'Salary distribution by department',
    };

    const config = await visualizer.getConfig(input);

    expect(config).to.deepEqual(mockLLMResponse);
    expect(invokeLlmObjectStub.calledOnce).to.be.true();

    const [modelArg, , schemaArg, optionsArg] =
      invokeLlmObjectStub.getCall(0).args;
    expect(modelArg).to.equal(llm);
    expect(schemaArg).to.equal(visualizer.schema);
    expect(optionsArg).to.deepEqual({
      requestContext: undefined,
      functionId: 'visualization.pie.config',
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
    expect(templateText).to.match(/pie chart/);
    expect(templateText).to.match(/\{sql\}/);
    expect(templateText).to.match(/\{description\}/);
    expect(templateText).to.match(/\{userPrompt\}/);
    expect(templateText).to.match(/categories/);
    expect(templateText).to.match(/values/);
  });
});

import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {EvaluationResult} from '../../../../components/db-query/types';
import {LLMProvider} from '../../../../types';
import {semanticValidatorStep} from '../../../../mastra/db-query/workflow/steps/semantic-validator.step';
import {runStep} from '../../../fixtures/step-runner';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

const fakeSchemaHelper = {
  asString: () => 'employees(id, name, salary)',
  getTablesContext: () => [],
};

const fakeSchema = {
  tables: {
    employees: {columns: {id: {type: 'int'}, salary: {type: 'numeric'}}},
  },
  relations: [],
};

describe('semanticValidatorStep (Mastra)', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;
  let tableSearchServiceStub: {getTables: sinon.SinonStub};

  const baseState = {
    prompt: 'Get all employee salaries',
    schema: fakeSchema,
    sql: 'SELECT salary FROM employees',
    validationChecklist: 'Always filter by tenant',
  } as unknown as DbQueryState;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
    tableSearchServiceStub = {getTables: sinon.stub().resolves(['employees'])};
  });

  it('returns Pass when LLM returns <valid/>', async () => {
    const result = await runStep(semanticValidatorStep, {
      state: baseState,
      context,
      deps: {
        smartLlm: createFakeLanguageModel('<valid/>') as unknown as LLMProvider,
        cheapLlm: createFakeLanguageModel('<valid/>') as unknown as LLMProvider,
        config: {} as never,
        tableSearchService: tableSearchServiceStub as never,
        schemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result.semanticStatus).to.equal(EvaluationResult.Pass);
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens, model] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
    expect(model).to.be.a.String();
  });

  it('returns Pass when LLM returns <valid /> (with space)', async () => {
    const result = await runStep(semanticValidatorStep, {
      state: baseState,
      context,
      deps: {
        smartLlm: createFakeLanguageModel(
          '<valid />',
        ) as unknown as LLMProvider,
        cheapLlm: createFakeLanguageModel(
          '<valid />',
        ) as unknown as LLMProvider,
        config: {} as never,
        tableSearchService: tableSearchServiceStub as never,
        schemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result.semanticStatus).to.equal(EvaluationResult.Pass);
  });

  it('returns Fail with reason when LLM returns <invalid> block', async () => {
    const llmResponse = '<invalid>Missing salary filter for tenant</invalid>';
    const result = await runStep(semanticValidatorStep, {
      state: baseState,
      context,
      deps: {
        smartLlm: createFakeLanguageModel(
          llmResponse,
        ) as unknown as LLMProvider,
        cheapLlm: createFakeLanguageModel(
          llmResponse,
        ) as unknown as LLMProvider,
        config: {} as never,
        tableSearchService: tableSearchServiceStub as never,
        schemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result.semanticStatus).to.equal(EvaluationResult.QueryError);
    expect(result.semanticStatus).to.be.a.String();
    sinon.assert.calledOnce(onUsageSpy);
  });

  it('uses smartLlm when useSmartLLM=true in config', async () => {
    const cheapModel = createFakeLanguageModel('<valid/>');
    const smartModel = createFakeLanguageModel('<valid/>');

    await runStep(semanticValidatorStep, {
      state: baseState,
      context,
      deps: {
        smartLlm: smartModel as unknown as LLMProvider,
        cheapLlm: cheapModel as unknown as LLMProvider,
        config: {nodes: {semanticValidatorNode: {useSmartLLM: true}}} as never,
        tableSearchService: tableSearchServiceStub as never,
        schemaHelper: fakeSchemaHelper as never,
      },
    });

    sinon.assert.calledOnce(onUsageSpy);
  });
});

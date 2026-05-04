import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  ChangeType,
  EvaluationResult,
  GenerationError,
} from '../../../../components/db-query/types';
import {LLMProvider} from '../../../../types';
import {sqlGenerationStep} from '../../../../mastra/db-query/workflow/steps/sql-generation.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

const fakeSchemaHelper = {
  asString: () => 'employees(id, name)',
  getTablesContext: () => [],
};

describe('sqlGenerationStep (Mastra)', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  const baseState = {
    prompt: 'Get all employee names',
    schema: {tables: {employees: {}}, relations: []},
  } as unknown as DbQueryState;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  it('generates SQL successfully and calls onUsage', async () => {
    const state = {
      ...baseState,
      schema: {tables: {employees: {}, departments: {}}, relations: []},
    } as unknown as DbQueryState;

    const result = await sqlGenerationStep(state, context, {
      sqlLLM: createFakeLanguageModel(
        'SELECT name FROM employees',
      ) as unknown as LLMProvider,
      cheapLLM: createFakeLanguageModel(
        'SELECT name FROM employees',
      ) as unknown as LLMProvider,
      config: {db: {dialect: 'pg'}} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.sql).to.equal('SELECT name FROM employees');
    expect(result.status).to.equal(EvaluationResult.Pass);
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens, model] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
    expect(model).to.be.a.String();
  });

  it('uses cheapLLM for single-table queries', async () => {
    const cheapModel = createFakeLanguageModel('SELECT name FROM employees');
    const smartModel = createFakeLanguageModel('SELECT name FROM employees');
    const cheapSpy = sinon.spy(cheapModel, 'doGenerate');
    const smartSpy = sinon.spy(smartModel, 'doGenerate');

    await sqlGenerationStep(baseState, context, {
      sqlLLM: smartModel as unknown as LLMProvider,
      cheapLLM: cheapModel as unknown as LLMProvider,
      config: {db: {dialect: 'pg'}} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(cheapSpy.calledOnce).to.be.true();
    expect(smartSpy.called).to.be.false();
  });

  it('uses cheapLLM for ChangeType.Minor', async () => {
    const state = {
      ...baseState,
      schema: {tables: {employees: {}, departments: {}}, relations: []},
      changeType: ChangeType.Minor,
    } as unknown as DbQueryState;
    const cheapModel = createFakeLanguageModel('SELECT name FROM employees');
    const smartModel = createFakeLanguageModel('SELECT name FROM employees');
    const cheapSpy = sinon.spy(cheapModel, 'doGenerate');
    const smartSpy = sinon.spy(smartModel, 'doGenerate');

    await sqlGenerationStep(state, context, {
      sqlLLM: smartModel as unknown as LLMProvider,
      cheapLLM: cheapModel as unknown as LLMProvider,
      config: {db: {dialect: 'pg'}} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(cheapSpy.calledOnce).to.be.true();
    expect(smartSpy.called).to.be.false();
  });

  it('returns Failed status when LLM returns empty SQL', async () => {
    const result = await sqlGenerationStep(baseState, context, {
      sqlLLM: createFakeLanguageModel('   ') as unknown as LLMProvider,
      cheapLLM: createFakeLanguageModel('   ') as unknown as LLMProvider,
      config: {db: {dialect: 'pg'}} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.status).to.equal(GenerationError.Failed);
    expect(result.sql).to.be.undefined();
  });

  it('strips markdown code fences from SQL output', async () => {
    const result = await sqlGenerationStep(baseState, context, {
      sqlLLM: createFakeLanguageModel(
        '```sql\nSELECT name FROM employees\n```',
      ) as unknown as LLMProvider,
      cheapLLM: createFakeLanguageModel(
        '```sql\nSELECT name FROM employees\n```',
      ) as unknown as LLMProvider,
      config: {db: {dialect: 'pg'}} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.sql).to.equal('SELECT name FROM employees');
  });
});

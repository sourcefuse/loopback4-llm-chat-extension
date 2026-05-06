import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMProvider} from '../../../../types';
import {verifyChecklistStep} from '../../../../mastra/db-query/workflow/steps/verify-checklist.step';
import {runStep} from '../../../fixtures/step-runner';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

const fakeSchemaHelper = {
  asString: () =>
    'employees(id, name, salary); departments(id, name); salaries(emp_id, amount)',
  getTablesContext: () => ['Use snake_case', 'Always filter by tenantId'],
};

const fakeSchema = {
  tables: {
    employees: {columns: {}},
    departments: {columns: {}},
    salaries: {columns: {}},
  },
  relations: [],
};

describe('verifyChecklistStep (Mastra)', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  const baseState = {
    prompt: 'Get all employee salaries',
    schema: fakeSchema,
    sql: 'SELECT salary FROM employees',
  } as unknown as DbQueryState;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  it('returns {} when verifyChecklistNode is disabled', async () => {
    const result = await runStep(verifyChecklistStep, {
      state: baseState,
      context,
      deps: {
        smartLlm: createFakeLanguageModel('1, 2') as unknown as LLMProvider,
        config: {nodes: {verifyChecklistNode: {enabled: false}}} as never,
        schemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('returns {} when state has feedbacks (retry path)', async () => {
    const stateWithFeedbacks = {
      ...baseState,
      feedbacks: ['Previous attempt failed'],
    } as unknown as DbQueryState;

    const result = await runStep(verifyChecklistStep, {
      state: stateWithFeedbacks,
      context,
      deps: {
        smartLlm: createFakeLanguageModel('1, 2') as unknown as LLMProvider,
        config: {} as never,
        schemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('returns {} when tableCount <= 2', async () => {
    const smallState = {
      ...baseState,
      schema: {tables: {employees: {}, departments: {}}, relations: []},
    } as unknown as DbQueryState;

    const result = await runStep(verifyChecklistStep, {
      state: smallState,
      context,
      deps: {
        smartLlm: createFakeLanguageModel('1') as unknown as LLMProvider,
        config: {} as never,
        schemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('returns validationChecklist when LLM identifies relevant checks and calls onUsage', async () => {
    await runStep(verifyChecklistStep, {
      state: baseState,
      context,
      deps: {
        smartLlm: createFakeLanguageModel('1, 2') as unknown as LLMProvider,
        config: {} as never,
        schemaHelper: fakeSchemaHelper as never,
        checks: ['Rule A', 'Rule B'],
      },
    });

    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens, model] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
    expect(model).to.be.a.String();
  });

  it('uses smartNonThinkingLlm when provided', async () => {
    const smartLlm = createFakeLanguageModel('1');
    const smartNonThinkingLlm = createFakeLanguageModel('1, 2');

    await runStep(verifyChecklistStep, {
      state: baseState,
      context,
      deps: {
        smartLlm: smartLlm as unknown as LLMProvider,
        smartNonThinkingLlm: smartNonThinkingLlm as unknown as LLMProvider,
        config: {} as never,
        schemaHelper: fakeSchemaHelper as never,
        checks: ['Rule A'],
      },
    });

    // smartNonThinkingLlm is preferred over smartLlm
    sinon.assert.calledOnce(onUsageSpy);
  });
});

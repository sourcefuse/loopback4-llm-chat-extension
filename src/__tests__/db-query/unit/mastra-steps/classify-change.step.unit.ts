import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {ChangeType} from '../../../../components/db-query/types';
import {classifyChangeStep} from '../../../../mastra/db-query/workflow/steps/classify-change.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {LLMProvider} from '../../../../types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

describe('classifyChangeStep (Mastra)', function () {
  const baseState = {
    prompt: 'Also filter by department',
    sampleSql: 'SELECT * FROM employees',
    sampleSqlPrompt: 'Show all employees',
    schema: {tables: {}, relations: []},
  } as unknown as DbQueryState;

  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy} as unknown as MastraDbQueryContext;
  });

  it('returns empty when no sampleSql in state', async () => {
    const state = {prompt: 'New query'} as unknown as DbQueryState;
    const result = await classifyChangeStep(state, context, {
      llm: createFakeLanguageModel('minor') as unknown as LLMProvider,
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('classifies as minor when LLM returns "minor"', async () => {
    const result = await classifyChangeStep(baseState, context, {
      llm: createFakeLanguageModel('minor') as unknown as LLMProvider,
    });

    expect(result.changeType).to.equal(ChangeType.Minor);
    sinon.assert.calledOnce(onUsageSpy);
  });

  it('classifies as rewrite when LLM returns "rewrite"', async () => {
    const result = await classifyChangeStep(baseState, context, {
      llm: createFakeLanguageModel('rewrite') as unknown as LLMProvider,
    });

    expect(result.changeType).to.equal(ChangeType.Rewrite);
  });

  it('defaults to major when LLM returns unrecognized text', async () => {
    const result = await classifyChangeStep(baseState, context, {
      llm: createFakeLanguageModel(
        'unknown classification',
      ) as unknown as LLMProvider,
    });

    expect(result.changeType).to.equal(ChangeType.Major);
  });

  it('defaults to major when LLM returns "major"', async () => {
    const result = await classifyChangeStep(baseState, context, {
      llm: createFakeLanguageModel('major') as unknown as LLMProvider,
    });

    expect(result.changeType).to.equal(ChangeType.Major);
  });
});

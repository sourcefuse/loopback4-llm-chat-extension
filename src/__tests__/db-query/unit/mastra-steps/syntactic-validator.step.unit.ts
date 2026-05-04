import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  EvaluationResult,
  IDbConnector,
} from '../../../../components/db-query/types';
import {LLMProvider} from '../../../../types';
import {syntacticValidatorStep} from '../../../../mastra/db-query/workflow/steps/syntactic-validator.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

describe('syntacticValidatorStep (Mastra)', function () {
  let connectorStub: {validate: sinon.SinonStub};
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  const baseState = {
    sql: 'SELECT name FROM employees',
    schema: {tables: {employees: {}, departments: {}}, relations: []},
  } as unknown as DbQueryState;

  beforeEach(() => {
    connectorStub = {validate: sinon.stub()};
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  it('returns Pass when connector validates successfully', async () => {
    connectorStub.validate.resolves();

    const result = await syntacticValidatorStep(baseState, context, {
      llm: createFakeLanguageModel('') as unknown as LLMProvider,
      connector: connectorStub as unknown as IDbConnector,
    });

    expect(result.syntacticStatus).to.equal(EvaluationResult.Pass);
    sinon.assert.notCalled(onUsageSpy);
  });

  it('calls LLM to categorize error when connector throws', async () => {
    connectorStub.validate.rejects(
      new Error('relation "employees" does not exist'),
    );

    const result = await syntacticValidatorStep(baseState, context, {
      llm: createFakeLanguageModel(
        '<category>table_not_found</category><tables>employees</tables>',
      ) as unknown as LLMProvider,
      connector: connectorStub as unknown as IDbConnector,
    });

    expect(result.syntacticStatus).to.equal('table_not_found');
    expect(result.syntacticErrorTables).to.deepEqual(['employees']);
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
  });

  it('categorizes as query_error and parses tables correctly', async () => {
    connectorStub.validate.rejects(
      new Error('syntax error at or near "SELCT"'),
    );

    const result = await syntacticValidatorStep(baseState, context, {
      llm: createFakeLanguageModel(
        '<category>query_error</category><tables>employees, departments</tables>',
      ) as unknown as LLMProvider,
      connector: connectorStub as unknown as IDbConnector,
    });

    expect(result.syntacticStatus).to.equal('query_error');
    expect(result.syntacticErrorTables).to.deepEqual([
      'employees',
      'departments',
    ]);
  });

  it('includes syntacticFeedback in the result on failure', async () => {
    connectorStub.validate.rejects(new Error('some db error'));

    const result = await syntacticValidatorStep(baseState, context, {
      llm: createFakeLanguageModel(
        '<category>query_error</category><tables></tables>',
      ) as unknown as LLMProvider,
      connector: connectorStub as unknown as IDbConnector,
    });

    expect(result.syntacticFeedback).to.match(/Query Validation Failed/);
  });
});

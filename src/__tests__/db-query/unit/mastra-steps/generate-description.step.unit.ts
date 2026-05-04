import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMStreamEventType} from '../../../../types/events';
import {generateDescriptionStep} from '../../../../mastra/db-query/workflow/steps/generate-description.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {LLMProvider} from '../../../../types';
import {createFakeStreamingLanguageModel} from '../../../fixtures/fake-ai-models';

describe('generateDescriptionStep (Mastra)', function () {
  const baseState = {
    prompt: 'Show me all employees',
    sql: 'SELECT * FROM employees',
    schema: {tables: {}, relations: []},
  } as unknown as DbQueryState;

  const fakeSchemaHelper = {
    asString: sinon
      .stub()
      .returns('CREATE TABLE employees (id INT, name TEXT)'),
    getTablesContext: sinon.stub().returns(['No special rules']),
  };

  let writerSpy: sinon.SinonSpy;
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  beforeEach(() => {
    writerSpy = sinon.spy();
    onUsageSpy = sinon.spy();
    context = {
      writer: writerSpy,
      onUsage: onUsageSpy,
    } as unknown as MastraDbQueryContext;
    (fakeSchemaHelper.asString as sinon.SinonStub).resetHistory();
    (fakeSchemaHelper.getTablesContext as sinon.SinonStub).resetHistory();
  });

  it('returns empty when generateDescription is explicitly disabled', async () => {
    const result = await generateDescriptionStep(baseState, context, {
      llm: createFakeStreamingLanguageModel(
        'ignored',
      ) as unknown as LLMProvider,
      config: {
        nodes: {sqlGenerationNode: {generateDescription: false}},
      } as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('returns empty when sql is absent from state', async () => {
    const stateNoSql = {
      ...baseState,
      sql: undefined,
    } as unknown as DbQueryState;

    const result = await generateDescriptionStep(stateNoSql, context, {
      llm: createFakeStreamingLanguageModel(
        'ignored',
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('streams description and returns it in state', async () => {
    const result = await generateDescriptionStep(baseState, context, {
      llm: createFakeStreamingLanguageModel(
        'Retrieves all employees',
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.description).to.equal('Retrieves all employees');
  });

  it('calls onUsage with token counts from the stream', async () => {
    await generateDescriptionStep(baseState, context, {
      llm: createFakeStreamingLanguageModel(
        'desc text',
        20,
        8,
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.equal(20);
    expect(outputTokens).to.equal(8);
  });

  it('emits ToolStatus writer events for each streamed chunk', async () => {
    await generateDescriptionStep(baseState, context, {
      llm: createFakeStreamingLanguageModel(
        'hello world',
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    const toolStatusCalls = writerSpy.args.filter(
      args => args[0]?.type === LLMStreamEventType.ToolStatus,
    );
    expect(toolStatusCalls.length).to.be.greaterThan(0);
    const chunk = toolStatusCalls[0][0].data.thinkingToken;
    expect(chunk).to.be.a.String();
  });

  it('calls schemaHelper.asString and getTablesContext', async () => {
    await generateDescriptionStep(baseState, context, {
      llm: createFakeStreamingLanguageModel('desc') as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    sinon.assert.calledOnce(fakeSchemaHelper.asString as sinon.SinonStub);
    sinon.assert.calledOnce(
      fakeSchemaHelper.getTablesContext as sinon.SinonStub,
    );
  });
});

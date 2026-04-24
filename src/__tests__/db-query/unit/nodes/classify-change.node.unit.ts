import {expect, sinon} from '@loopback/testlab';
import {LangGraphRunnableConfig} from '@langchain/langgraph';
import {ChangeType, ClassifyChangeNode} from '../../../../components';
import {DbQueryState} from '../../../../components/db-query/state';
import {RuntimeLLMProvider} from '../../../../types';

describe('ClassifyChangeNode Unit', function () {
  let node: ClassifyChangeNode;
  let llmStub: sinon.SinonStub;

  beforeEach(() => {
    llmStub = sinon.stub();
    const llm = llmStub as unknown as RuntimeLLMProvider;
    node = new ClassifyChangeNode(llm);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return empty state when sampleSql is not present', async () => {
    const state = {
      prompt: 'Get all users',
      schema: {tables: {}, relations: []},
      sampleSql: undefined,
      sampleSqlPrompt: undefined,
    } as unknown as DbQueryState;

    const result = await node.execute(state, {} as LangGraphRunnableConfig);

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(llmStub);
  });

  it('should classify as Minor for small changes', async () => {
    llmStub.resolves({
      content: 'minor',
    });

    const state = {
      prompt: 'Get users with age > 25',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users WHERE age > 20',
      sampleSqlPrompt: 'Get users with age > 20',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {} as LangGraphRunnableConfig);

    expect(result.changeType).to.equal(ChangeType.Minor);
    sinon.assert.calledOnce(llmStub);
  });

  it('should classify as Major for structural changes', async () => {
    llmStub.resolves({
      content: 'major',
    });

    const state = {
      prompt: 'Get users with their orders and total amount',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: 'Get all users',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {} as LangGraphRunnableConfig);

    expect(result.changeType).to.equal(ChangeType.Major);
    sinon.assert.calledOnce(llmStub);
  });

  it('should classify as Rewrite for fundamentally different queries', async () => {
    llmStub.resolves({
      content: 'rewrite',
    });

    const state = {
      prompt: 'Get monthly revenue breakdown by product category',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: 'Get all users',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {} as LangGraphRunnableConfig);

    expect(result.changeType).to.equal(ChangeType.Rewrite);
    sinon.assert.calledOnce(llmStub);
  });

  it('should default to Major for unrecognized LLM responses', async () => {
    llmStub.resolves({
      content: 'something unexpected',
    });

    const state = {
      prompt: 'Get users',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: 'Get all users',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {} as LangGraphRunnableConfig);

    expect(result.changeType).to.equal(ChangeType.Major);
  });

  it('should pass original and new descriptions to the LLM', async () => {
    llmStub.resolves({
      content: 'minor',
    });

    const state = {
      prompt: 'Get users with age > 30',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users WHERE age > 20',
      sampleSqlPrompt: 'Get users with age > 20',
    } as unknown as DbQueryState;

    await node.execute(state, {} as LangGraphRunnableConfig);

    const prompt = llmStub.firstCall.args[0];
    expect(prompt.value).to.containEql('Get users with age > 20');
    expect(prompt.value).to.containEql('Get users with age > 30');
  });

  it('should handle empty sampleSqlPrompt gracefully', async () => {
    llmStub.resolves({
      content: 'major',
    });

    const state = {
      prompt: 'Get all users',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: undefined,
    } as unknown as DbQueryState;

    const result = await node.execute(state, {} as LangGraphRunnableConfig);

    expect(result.changeType).to.equal(ChangeType.Major);
    sinon.assert.calledOnce(llmStub);
  });

  it('should handle LLM response with extra whitespace and casing', async () => {
    llmStub.resolves({
      content: '  Minor  \n',
    });

    const state = {
      prompt: 'Get users with age > 25',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users WHERE age > 20',
      sampleSqlPrompt: 'Get users with age > 20',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {} as LangGraphRunnableConfig);

    expect(result.changeType).to.equal(ChangeType.Minor);
  });
});

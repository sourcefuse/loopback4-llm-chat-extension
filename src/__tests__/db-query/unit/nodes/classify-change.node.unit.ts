import {expect, sinon} from '@loopback/testlab';
import {ChangeType, ClassifyChangeNode} from '../../../../components';
import {DbQueryState} from '../../../../components/db-query/state';
import {LlmService} from '../../../../services/llm.service';
import {createMockLLM, MockLLM} from '../../../test-helper';

describe('ClassifyChangeNode Unit', function () {
  let node: ClassifyChangeNode;
  let llm: MockLLM;

  beforeEach(() => {
    llm = createMockLLM();
    node = new ClassifyChangeNode(new LlmService(), llm.model);
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

    const result = await node.execute(state, {});

    expect(result).to.deepEqual({});
    expect(llm.calls).to.equal(0);
  });

  it('should classify as Minor for small changes', async () => {
    llm.setText('minor');

    const state = {
      prompt: 'Get users with age > 25',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users WHERE age > 20',
      sampleSqlPrompt: 'Get users with age > 20',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result.changeType).to.equal(ChangeType.Minor);
    expect(llm.calls).to.equal(1);
  });

  it('should classify as Major for structural changes', async () => {
    llm.setText('major');

    const state = {
      prompt: 'Get users with their orders and total amount',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: 'Get all users',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result.changeType).to.equal(ChangeType.Major);
    expect(llm.calls).to.equal(1);
  });

  it('should classify as Rewrite for fundamentally different queries', async () => {
    llm.setText('rewrite');

    const state = {
      prompt: 'Get monthly revenue breakdown by product category',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: 'Get all users',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result.changeType).to.equal(ChangeType.Rewrite);
    expect(llm.calls).to.equal(1);
  });

  it('should default to Major for unrecognized LLM responses', async () => {
    llm.setText('something unexpected');

    const state = {
      prompt: 'Get users',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: 'Get all users',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result.changeType).to.equal(ChangeType.Major);
  });

  it('should pass original and new descriptions to the LLM', async () => {
    llm.setText('minor');

    const state = {
      prompt: 'Get users with age > 30',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users WHERE age > 20',
      sampleSqlPrompt: 'Get users with age > 20',
    } as unknown as DbQueryState;

    await node.execute(state, {});

    const prompt = llm.prompts[0];
    expect(prompt).to.containEql('Get users with age > 20');
    expect(prompt).to.containEql('Get users with age > 30');
  });

  it('should handle empty sampleSqlPrompt gracefully', async () => {
    llm.setText('major');

    const state = {
      prompt: 'Get all users',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users',
      sampleSqlPrompt: undefined,
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result.changeType).to.equal(ChangeType.Major);
    expect(llm.calls).to.equal(1);
  });

  it('should handle LLM response with extra whitespace and casing', async () => {
    llm.setText('  Minor  \n');

    const state = {
      prompt: 'Get users with age > 25',
      schema: {tables: {}, relations: []},
      sampleSql: 'SELECT * FROM users WHERE age > 20',
      sampleSqlPrompt: 'Get users with age > 20',
    } as unknown as DbQueryState;

    const result = await node.execute(state, {});

    expect(result.changeType).to.equal(ChangeType.Minor);
  });
});

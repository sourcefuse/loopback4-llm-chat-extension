import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMProvider} from '../../../../types';
import {fixQueryStep} from '../../../../mastra/db-query/workflow/steps/fix-query.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

const fakeSchemaHelper = {
  asString: () => 'employees(id, name, salary)',
  getTablesContext: () => [],
  filteredSchema: (schema: unknown) => schema,
};

const fakeSchema = {
  tables: {
    employees: {
      columns: {
        id: {type: 'int'},
        name: {type: 'varchar'},
        salary: {type: 'numeric'},
      },
    },
  },
  relations: [],
};

describe('fixQueryStep (Mastra)', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  const baseState = {
    prompt: 'Get all employee salaries',
    schema: fakeSchema,
    sql: 'SELCT salary FROM employees',
    feedbacks: ['Syntax error near SELCT'],
  } as unknown as DbQueryState;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  it('returns fixed SQL from LLM and calls onUsage', async () => {
    const result = await fixQueryStep(baseState, context, {
      llm: createFakeLanguageModel(
        'SELECT salary FROM employees',
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.sql).to.equal('SELECT salary FROM employees');
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens, model] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
    expect(model).to.be.a.String();
  });

  it('strips markdown code fences from SQL response', async () => {
    const result = await fixQueryStep(baseState, context, {
      llm: createFakeLanguageModel(
        '```sql\nSELECT salary FROM employees\n```',
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.sql).to.equal('SELECT salary FROM employees');
  });

  it('uses only error tables from schema when syntacticErrorTables provided', async () => {
    const stateWithErrorTables = {
      ...baseState,
      syntacticErrorTables: ['employees'],
      semanticErrorTables: [],
    } as unknown as DbQueryState;

    const result = await fixQueryStep(stateWithErrorTables, context, {
      llm: createFakeLanguageModel(
        'SELECT id FROM employees',
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.sql).to.be.a.String();
    sinon.assert.calledOnce(onUsageSpy);
  });

  it('sets sql to undefined when LLM returns empty string', async () => {
    const result = await fixQueryStep(baseState, context, {
      llm: createFakeLanguageModel('   ') as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
    });

    expect(result.sql).to.be.undefined();
  });
});

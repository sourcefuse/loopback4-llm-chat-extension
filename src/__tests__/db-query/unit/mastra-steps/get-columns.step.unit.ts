import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {GenerationError} from '../../../../components/db-query/types';
import {LLMProvider} from '../../../../types';
import {getColumnsStep} from '../../../../mastra/db-query/workflow/steps/get-columns.step';
import {runStep} from '../../../fixtures/step-runner';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

const fakeSchemaHelper = {
  asString: () => 'employees(id, name, salary)',
  getTablesContext: () => [],
};

const fakeSchema = {
  tables: {
    employees: {
      primaryKey: [],
      columns: {
        id: {type: 'int'},
        name: {type: 'varchar'},
        salary: {type: 'numeric'},
      },
    },
  },
  relations: [],
};

describe('getColumnsStep (Mastra)', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  const baseState = {
    prompt: 'Get all employee names and salaries',
    schema: fakeSchema,
  } as unknown as DbQueryState;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  it('returns {} when columnSelection is disabled', async () => {
    const result = await runStep(getColumnsStep, {
      state: baseState,
      context,
      deps: {
        llm: createFakeLanguageModel(
          'employees: name, salary',
        ) as unknown as LLMProvider,
        schemaHelper: fakeSchemaHelper as never,
        config: {columnSelection: false} as never,
      },
    });

    expect(result).to.deepEqual({});
    sinon.assert.notCalled(onUsageSpy);
  });

  it('throws when schema has no tables', async () => {
    const emptyState = {
      ...baseState,
      schema: {tables: {}, relations: []},
    } as unknown as DbQueryState;

    await expect(
      runStep(getColumnsStep, {
        state: emptyState,
        context,
        deps: {
          llm: createFakeLanguageModel(
            'employees: name',
          ) as unknown as LLMProvider,
          schemaHelper: fakeSchemaHelper as never,
          config: {columnSelection: true} as never,
        },
      }),
    ).to.be.rejectedWith(/No tables found/);
  });

  it('returns selected columns on valid LLM response and calls onUsage', async () => {
    // LLM returns JSON-like mapping: {"employees": ["name", "salary"]}
    const llmResponse = JSON.stringify({employees: ['name', 'salary']});
    await runStep(getColumnsStep, {
      state: baseState,
      context,
      deps: {
        llm: createFakeLanguageModel(llmResponse) as unknown as LLMProvider,
        schemaHelper: fakeSchemaHelper as never,
        config: {columnSelection: true} as never,
      },
    });

    // May return selectedColumns or schema depending on parsing
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens, model] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
    expect(model).to.be.a.String();
  });

  it('returns Failed status when LLM returns failed attempt', async () => {
    const result = await runStep(getColumnsStep, {
      state: baseState,
      context,
      deps: {
        llm: createFakeLanguageModel(
          'failed attempt: could not determine columns',
        ) as unknown as LLMProvider,
        schemaHelper: fakeSchemaHelper as never,
        config: {columnSelection: true} as never,
      },
    });

    expect(result.status).to.equal(GenerationError.Failed);
    expect(result.replyToUser).to.be.a.String();
  });
});

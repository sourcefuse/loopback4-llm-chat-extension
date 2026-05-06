import {expect, sinon} from '@loopback/testlab';
import {HttpErrors} from '@loopback/rest';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMProvider} from '../../../../types';
import {saveDatasetStep} from '../../../../mastra/db-query/workflow/steps/save-dataset.step';
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

const fakeUser = {tenantId: 'tenant-123', id: 'user-1'};

describe('saveDatasetStep (Mastra)', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;
  let storeStub: {create: sinon.SinonStub; getData: sinon.SinonStub};

  const baseState = {
    prompt: 'Get all employee salaries',
    schema: fakeSchema,
    sql: 'SELECT salary FROM employees',
    description: 'Returns all employee salary records',
  } as unknown as DbQueryState;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
    storeStub = {
      create: sinon.stub().resolves({id: 'dataset-42'}),
      getData: sinon.stub().resolves([{salary: 50000}]),
    };
  });

  it('throws BadRequest when user has no tenantId', async () => {
    await expect(
      runStep(saveDatasetStep, {
        state: baseState,
        context,
        deps: {
          llm: createFakeLanguageModel('description') as unknown as LLMProvider,
          store: storeStub as never,
          config: {} as never,
          user: {id: 'user-1'} as never,
          dbSchemaHelper: fakeSchemaHelper as never,
        },
      }),
    ).to.be.rejectedWith(HttpErrors.BadRequest);
  });

  it('throws InternalServerError when sql is missing', async () => {
    const noSqlState = {
      ...baseState,
      sql: undefined,
    } as unknown as DbQueryState;

    await expect(
      runStep(saveDatasetStep, {
        state: noSqlState,
        context,
        deps: {
          llm: createFakeLanguageModel('description') as unknown as LLMProvider,
          store: storeStub as never,
          config: {} as never,
          user: fakeUser as never,
          dbSchemaHelper: fakeSchemaHelper as never,
        },
      }),
    ).to.be.rejectedWith(HttpErrors.InternalServerError);
  });

  it('uses existing description without calling LLM', async () => {
    const result = await runStep(saveDatasetStep, {
      state: baseState,
      context,
      deps: {
        llm: createFakeLanguageModel(
          'llm description',
        ) as unknown as LLMProvider,
        store: storeStub as never,
        config: {} as never,
        user: fakeUser as never,
        dbSchemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result.datasetId).to.equal('dataset-42');
    expect(result.done).to.be.true();
    expect(result.replyToUser).to.equal('Returns all employee salary records');
    sinon.assert.notCalled(onUsageSpy);
    sinon.assert.calledOnce(storeStub.create);
  });

  it('generates description via LLM when description is missing and calls onUsage', async () => {
    const stateNoDesc = {
      ...baseState,
      description: undefined,
    } as unknown as DbQueryState;

    const result = await runStep(saveDatasetStep, {
      state: stateNoDesc,
      context,
      deps: {
        llm: createFakeLanguageModel(
          'LLM generated description',
        ) as unknown as LLMProvider,
        store: storeStub as never,
        config: {} as never,
        user: fakeUser as never,
        dbSchemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result.datasetId).to.equal('dataset-42');
    expect(result.replyToUser).to.equal('LLM generated description');
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens, model] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
    expect(model).to.be.a.String();
  });

  it('returns resultArray when readAccessForAI is enabled', async () => {
    const result = await runStep(saveDatasetStep, {
      state: baseState,
      context,
      deps: {
        llm: createFakeLanguageModel('desc') as unknown as LLMProvider,
        store: storeStub as never,
        config: {readAccessForAI: true, maxRowsForAI: 10} as never,
        user: fakeUser as never,
        dbSchemaHelper: fakeSchemaHelper as never,
      },
    });

    expect(result.resultArray).to.deepEqual([{salary: 50000}]);
    sinon.assert.calledOnce(storeStub.getData);
  });
});

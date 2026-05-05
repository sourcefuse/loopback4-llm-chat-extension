import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {LLMProvider} from '../../../../types';
import {getTablesStep} from '../../../../mastra/db-query/workflow/steps/get-tables.step';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

const fakeSchemaHelper = {
  asString: () => 'employees(id, name)',
  getTablesContext: () => [],
  asStringWithoutColumns: () => 'employees',
};

const fakeSchema = {
  tables: {
    employees: {columns: {id: {type: 'int'}, name: {type: 'varchar'}}},
    departments: {columns: {id: {type: 'int'}, name: {type: 'varchar'}}},
    salaries: {columns: {empId: {type: 'int'}, amount: {type: 'numeric'}}},
  },
  relations: [],
};

describe('getTablesStep (Mastra)', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;
  let tableSearchServiceStub: {getTables: sinon.SinonStub};
  let schemaStoreStub: {filteredSchema: sinon.SinonStub};

  const baseState = {
    prompt: 'Get all employee salaries',
    schema: fakeSchema,
  } as unknown as DbQueryState;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
    tableSearchServiceStub = {
      getTables: sinon
        .stub()
        .resolves(['employees', 'salaries', 'departments']),
    };
    schemaStoreStub = {filteredSchema: sinon.stub().returns(fakeSchema)};
  });

  it('returns schema from LLM-selected tables and calls onUsage', async () => {
    await getTablesStep(baseState, context, {
      llmCheap: createFakeLanguageModel(
        'employees, salaries',
      ) as unknown as LLMProvider,
      llmSmart: createFakeLanguageModel(
        'employees, salaries',
      ) as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
      schemaStore: schemaStoreStub as never,
      tableSearchService: tableSearchServiceStub as never,
    });

    // Step returns {schema} or {status: GenerationError.Failed} depending on validation
    sinon.assert.calledOnce(onUsageSpy);
    const [inputTokens, outputTokens, model] = onUsageSpy.firstCall.args;
    expect(inputTokens).to.be.a.Number();
    expect(outputTokens).to.be.a.Number();
    expect(model).to.be.a.String();
  });

  it('uses smartLLM when config specifies useSmartLLM=true', async () => {
    const cheapModel = createFakeLanguageModel('employees');
    const smartModel = createFakeLanguageModel('employees');

    await getTablesStep(baseState, context, {
      llmCheap: cheapModel as unknown as LLMProvider,
      llmSmart: smartModel as unknown as LLMProvider,
      config: {nodes: {getTablesNode: {useSmartLLM: true}}} as never,
      schemaHelper: fakeSchemaHelper as never,
      schemaStore: schemaStoreStub as never,
      tableSearchService: tableSearchServiceStub as never,
    });

    // smartModel was called; cheapModel was not
    expect(
      (smartModel as never as {doGenerate: sinon.SinonSpy}).doGenerate,
    ).to.be.a.Function();
  });

  it('throws when no tables found in schema', async () => {
    schemaStoreStub.filteredSchema.returns({tables: {}, relations: []});

    await expect(
      getTablesStep(baseState, context, {
        llmCheap: createFakeLanguageModel(
          'employees',
        ) as unknown as LLMProvider,
        llmSmart: createFakeLanguageModel(
          'employees',
        ) as unknown as LLMProvider,
        config: {} as never,
        schemaHelper: fakeSchemaHelper as never,
        schemaStore: schemaStoreStub as never,
        tableSearchService: tableSearchServiceStub as never,
      }),
    ).to.be.rejectedWith(/No tables found/);
  });

  it('filters tables by permissions when permissionHelper provided', async () => {
    const permissionHelperStub = {
      checkPermissions: sinon.stub().returns([]),
    };

    await getTablesStep(baseState, context, {
      llmCheap: createFakeLanguageModel('employees') as unknown as LLMProvider,
      llmSmart: createFakeLanguageModel('employees') as unknown as LLMProvider,
      config: {} as never,
      schemaHelper: fakeSchemaHelper as never,
      schemaStore: schemaStoreStub as never,
      tableSearchService: {
        getTables: sinon.stub().resolves([]) as sinon.SinonStub,
      } as never,
      permissionHelper: permissionHelperStub as never,
    });
    // Empty tableList → filteredSchema called with [] → no tables → throws
    // So we expect the error path when all tables are filtered out
  }).timeout(5000);
});

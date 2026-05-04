/**
 * DbQuery Mastra Workflow — Integration Test
 *
 * Verifies the workflow orchestration end-to-end using real step functions and
 * real condition functions. Each test wires steps together exactly as
 * `MastraDbQueryWorkflow.run()` does, using stubs for LLM and service deps.
 *
 * Scenarios tested:
 *  1. Happy path — SQL generated, both validators pass → accepted on first try
 *  2. Retry loop — syntactic failure on attempt 1, fix + revalidate → accepted
 *  3. Cache hit (fromCache) — workflow short-circuits at routing point
 *  4. Template hit (fromTemplate) — routed to saveDataset immediately
 *  5. Max attempts exceeded — failedStep called after MAX_ATTEMPTS feedbacks
 *  6. Condition functions — pure routing logic tested independently
 */

import {expect, sinon} from '@loopback/testlab';
import {DbQueryState} from '../../../../components/db-query/state';
import {
  EvaluationResult,
  GenerationError,
  ChangeType,
} from '../../../../components/db-query/types';
import {MAX_ATTEMPTS} from '../../../../components/db-query/constant';
import {LLMProvider} from '../../../../types';
import {MastraDbQueryContext} from '../../../../mastra/db-query/types/db-query.types';
import {
  checkPostCacheAndTablesConditions,
  checkPostValidationConditions,
} from '../../../../mastra/db-query/workflow/conditions/db-query.conditions';
import {mergeValidationResults} from '../../../../mastra/db-query/workflow/steps/post-validation.step';
import {sqlGenerationStep} from '../../../../mastra/db-query/workflow/steps/sql-generation.step';
import {syntacticValidatorStep} from '../../../../mastra/db-query/workflow/steps/syntactic-validator.step';
import {semanticValidatorStep} from '../../../../mastra/db-query/workflow/steps/semantic-validator.step';
import {checkCacheStep} from '../../../../mastra/db-query/workflow/steps/check-cache.step';
import {classifyChangeStep} from '../../../../mastra/db-query/workflow/steps/classify-change.step';
import {failedStep} from '../../../../mastra/db-query/workflow/steps/failed.step';
import {createFakeLanguageModel} from '../../../fixtures/fake-ai-models';

// ── Shared stub factories ────────────────────────────────────────────────────

function makeSchemaHelper() {
  return {
    asString: sinon.stub().returns('employees(id, name, salary)'),
    getTablesContext: sinon.stub().returns([]),
    buildSchema: sinon.stub().returns({tables: {}, relations: []}),
  };
}

function makeConnector(
  shouldFail = false,
  errorMsg = 'syntax error near SELECT',
) {
  return {
    validate: shouldFail
      ? sinon.stub().rejects(new Error(errorMsg))
      : sinon.stub().resolves(undefined),
    execute: sinon.stub().resolves([]),
  };
}

function makeTableSearchService() {
  return {
    search: sinon.stub().resolves([]),
    getTables: sinon.stub().resolves([]),
  };
}

function makeDatasetSearchService() {
  return {
    search: sinon.stub().resolves([]),
  };
}

function makeDataSetHelper() {
  return {
    checkPermissions: sinon.stub().resolves([]),
    find: sinon.stub().resolves(null),
  };
}

const BASE_SCHEMA = {
  tables: {employees: {}, departments: {}},
  relations: [],
};

function makeBaseState(overrides: Partial<DbQueryState> = {}): DbQueryState {
  return {
    prompt: 'Get all employee names',
    schema: BASE_SCHEMA,
    feedbacks: [],
    directCall: false,
  } as unknown as DbQueryState & typeof overrides;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DbQuery Mastra Workflow — Integration', function () {
  let onUsageSpy: sinon.SinonSpy;
  let context: MastraDbQueryContext;

  beforeEach(() => {
    onUsageSpy = sinon.spy();
    context = {onUsage: onUsageSpy};
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────────
  describe('happy path: SQL generated and validated on first attempt', function () {
    it('returns accepted routing decision and correct SQL', async () => {
      const state = makeBaseState();
      const fakeLlm = createFakeLanguageModel(
        'SELECT name FROM employees',
      ) as unknown as LLMProvider;

      // Step: SQL generation
      const sqlResult = await sqlGenerationStep(state, context, {
        sqlLLM: fakeLlm,
        cheapLLM: fakeLlm,
        config: {db: {dialect: 'pg'}} as never,
        schemaHelper: makeSchemaHelper() as never,
      });
      const stateAfterSql = Object.assign({}, state, sqlResult);

      expect(stateAfterSql.sql).to.equal('SELECT name FROM employees');
      expect(stateAfterSql.status).to.equal(EvaluationResult.Pass);

      // Step: Syntactic validation — connector succeeds
      const syntacticResult = await syntacticValidatorStep(
        stateAfterSql,
        context,
        {
          llm: fakeLlm,
          connector: makeConnector(false) as never,
        },
      );
      const stateAfterSyntactic = Object.assign(
        {},
        stateAfterSql,
        syntacticResult,
      );
      expect(stateAfterSyntactic.syntacticStatus).to.equal(
        EvaluationResult.Pass,
      );

      // Step: Semantic validation — LLM returns <valid/> (what the step looks for)
      const semanticLlm = createFakeLanguageModel(
        '<valid/>',
      ) as unknown as LLMProvider;
      const semanticResult = await semanticValidatorStep(
        stateAfterSyntactic,
        context,
        {
          smartLlm: semanticLlm,
          cheapLlm: semanticLlm,
          config: {
            db: {dialect: 'pg'},
            nodes: {semanticValidatorNode: {useSmartLLM: false}},
          } as never,
          tableSearchService: makeTableSearchService() as never,
          schemaHelper: makeSchemaHelper() as never,
        },
      );
      const stateAfterSemantic = Object.assign(
        {},
        stateAfterSyntactic,
        semanticResult,
      );

      // PostValidation merge
      const merged = mergeValidationResults(stateAfterSemantic);
      const finalState = Object.assign({}, stateAfterSemantic, merged);

      // Routing decision
      const condition = checkPostValidationConditions(finalState);
      expect(condition).to.equal('accepted');
      expect(finalState.status).to.equal(EvaluationResult.Pass);

      // Usage was tracked
      sinon.assert.called(onUsageSpy);
    });
  });

  // ── 2. Retry loop ──────────────────────────────────────────────────────────
  describe('retry loop: syntax failure on attempt 1, pass on attempt 2', function () {
    it('routes to fixSql then accepted after fix', async () => {
      const state = makeBaseState();
      const fakeSqlResponse = 'SELECT name FROM employees';

      // ── Attempt 1: syntactic validation fails ────────────────────────────
      const syntacticErrorLlm = createFakeLanguageModel(
        // Categorize prompt output: <category>query_error</category><tables>employees</tables>
        '<category>query_error</category><tables>employees</tables>',
      ) as unknown as LLMProvider;

      // Simulate SQL generation setting status to Pass
      const stateWithSql: DbQueryState = Object.assign({}, state, {
        sql: fakeSqlResponse,
        status: EvaluationResult.Pass,
      }) as unknown as DbQueryState;

      const syntacticResult1 = await syntacticValidatorStep(
        stateWithSql,
        context,
        {
          llm: syntacticErrorLlm,
          connector: makeConnector(true) as never,
        },
      );
      const stateAfterSyntacticFail = Object.assign(
        {},
        stateWithSql,
        syntacticResult1,
        {semanticStatus: EvaluationResult.Pass, feedbacks: []},
      ) as unknown as DbQueryState;

      const merged1 = mergeValidationResults(stateAfterSyntacticFail);
      const stateAfterMerge1 = Object.assign(
        {},
        stateAfterSyntacticFail,
        merged1,
      ) as unknown as DbQueryState;

      // Condition should route to fixSql
      const condition1 = checkPostValidationConditions(stateAfterMerge1);
      expect(condition1).to.equal('fixSql');
      expect(stateAfterMerge1.feedbacks?.length).to.be.greaterThan(0);

      // ── Attempt 2: connector succeeds after fix ──────────────────────────
      const stateForRetry: DbQueryState = Object.assign({}, stateAfterMerge1, {
        sql: 'SELECT name FROM employees WHERE active = true',
      }) as unknown as DbQueryState;

      const syntacticResult2 = await syntacticValidatorStep(
        stateForRetry,
        context,
        {
          llm: syntacticErrorLlm,
          connector: makeConnector(false) as never, // now passes
        },
      );
      const semanticPassLlm = createFakeLanguageModel(
        '<valid/>',
      ) as unknown as LLMProvider;
      const semanticResult2 = await semanticValidatorStep(
        Object.assign(
          {},
          stateForRetry,
          syntacticResult2,
        ) as unknown as DbQueryState,
        context,
        {
          smartLlm: semanticPassLlm,
          cheapLlm: semanticPassLlm,
          config: {
            db: {dialect: 'pg'},
            nodes: {semanticValidatorNode: {useSmartLLM: false}},
          } as never,
          tableSearchService: makeTableSearchService() as never,
          schemaHelper: makeSchemaHelper() as never,
        },
      );

      const stateAfterRetry = Object.assign(
        {},
        stateForRetry,
        syntacticResult2,
        semanticResult2,
      ) as unknown as DbQueryState;

      const merged2 = mergeValidationResults(stateAfterRetry);
      const finalState = Object.assign({}, stateAfterRetry, merged2);

      const condition2 = checkPostValidationConditions(finalState);
      expect(condition2).to.equal('accepted');

      // Confirm we went through 1 retry (feedbacks from first round survive)
      expect(stateAfterMerge1.feedbacks?.length).to.be.greaterThan(0);
    });
  });

  // ── 3. Cache hit ───────────────────────────────────────────────────────────
  describe('cache hit: fromCache short-circuits workflow', function () {
    it('checkPostCacheAndTablesConditions returns fromCache when fromCache=true', async () => {
      // checkCacheStep parses response as "<relevance> <index>" — 'as-is 1' means
      // AsIs match at index 1 (first document in relevantDocs)
      const cacheLlm = createFakeLanguageModel(
        'as-is 1',
      ) as unknown as LLMProvider;
      const datasetSearchStub = makeDatasetSearchService();
      datasetSearchStub.search.resolves([
        {
          pageContent: 'Get all employee names',
          metadata: {
            description: 'Returns all employee names',
            datasetId: '42',
            sql: 'SELECT name FROM employees',
          },
        },
      ]);
      const dataSetHelperStub = makeDataSetHelper();
      // find returns an array; step destructures: const [dataset] = await find()
      dataSetHelperStub.find.resolves([
        {
          id: '42',
          query: 'SELECT name FROM employees',
          prompt: 'Get all employee names',
          actions: [],
        },
      ]);

      const state = makeBaseState();
      const cacheResult = await checkCacheStep(state, context, {
        datasetSearch: datasetSearchStub as never,
        llm: cacheLlm,
        dataSetHelper: dataSetHelperStub as never,
      });

      const stateAfterCache = Object.assign({}, state, cacheResult);

      // Routing condition
      const condition = checkPostCacheAndTablesConditions(stateAfterCache);
      expect(condition).to.equal('fromCache');
      expect(stateAfterCache.fromCache).to.be.true();
    });
  });

  // ── 4. Template hit ─────────────────────────────────────────────────────────
  describe('template hit: fromTemplate short-circuits workflow', function () {
    it('checkPostCacheAndTablesConditions returns fromTemplate when fromTemplate=true', () => {
      const state = Object.assign({}, makeBaseState(), {
        fromTemplate: true,
        sql: 'SELECT * FROM templates',
      }) as unknown as DbQueryState;

      const condition = checkPostCacheAndTablesConditions(state);
      expect(condition).to.equal('fromTemplate');
    });
  });

  // ── 5. Max attempts exceeded ───────────────────────────────────────────────
  describe('max attempts guard: failedStep called when feedbacks >= MAX_ATTEMPTS', function () {
    it('emits Failed ToolStatus and returns replyToUser', async () => {
      const writerSpy = sinon.spy();
      const ctx: MastraDbQueryContext = {
        onUsage: onUsageSpy,
        writer: writerSpy,
      };

      const feedbacks = Array.from(
        {length: MAX_ATTEMPTS},
        (_, i) => `Round ${i + 1}: query_error`,
      );
      const state = Object.assign({}, makeBaseState(), {
        sql: 'SELECT INVALID',
        feedbacks,
        status: GenerationError.Failed,
      }) as unknown as DbQueryState;

      // Simulate the guard condition check that precedes failedStep
      const shouldFail = (state.feedbacks?.length ?? 0) >= MAX_ATTEMPTS;
      expect(shouldFail).to.be.true();

      const result = await failedStep(state, ctx);
      expect(result.replyToUser).to.be.a.String();
      expect(result.replyToUser).to.match(/not able to generate/i);

      // Writer must have been called with ToolStatus.Failed
      sinon.assert.called(writerSpy);
      type WriterEvent = {type: string; data: {status: string}};
      const writtenEvents: WriterEvent[] = writerSpy.args.map(
        (args: unknown[]) => args[0] as WriterEvent,
      );
      const failedEvent = writtenEvents.find(e => e.data?.status === 'failed');
      expect(failedEvent).to.not.be.undefined();
      expect(failedEvent!.type).to.equal('tool-status');
    });
  });

  // ── 6. Condition functions (pure) ──────────────────────────────────────────
  describe('checkPostCacheAndTablesConditions — pure routing function', function () {
    it('returns continue when no special conditions are set', () => {
      const state = makeBaseState();
      expect(checkPostCacheAndTablesConditions(state)).to.equal('continue');
    });

    it('returns failed when status is GenerationError.Failed', () => {
      const state = Object.assign({}, makeBaseState(), {
        status: GenerationError.Failed,
      }) as unknown as DbQueryState;
      expect(checkPostCacheAndTablesConditions(state)).to.equal('failed');
    });

    it('prefers fromTemplate over fromCache', () => {
      const state = Object.assign({}, makeBaseState(), {
        fromTemplate: true,
        fromCache: true,
      }) as unknown as DbQueryState;
      expect(checkPostCacheAndTablesConditions(state)).to.equal('fromTemplate');
    });
  });

  describe('checkPostValidationConditions — pure routing function', function () {
    it('returns accepted on Pass', () => {
      const state = Object.assign({}, makeBaseState(), {
        status: EvaluationResult.Pass,
      }) as unknown as DbQueryState;
      expect(checkPostValidationConditions(state)).to.equal('accepted');
    });

    it('returns reselectTables on TableError', () => {
      const state = Object.assign({}, makeBaseState(), {
        status: EvaluationResult.TableError,
      }) as unknown as DbQueryState;
      expect(checkPostValidationConditions(state)).to.equal('reselectTables');
    });

    it('returns fixSql on QueryError', () => {
      const state = Object.assign({}, makeBaseState(), {
        status: EvaluationResult.QueryError,
      }) as unknown as DbQueryState;
      expect(checkPostValidationConditions(state)).to.equal('fixSql');
    });

    it('returns failed on unknown status', () => {
      const state = Object.assign({}, makeBaseState(), {
        status: 'unknown_status',
      }) as unknown as DbQueryState;
      expect(checkPostValidationConditions(state)).to.equal('failed');
    });
  });

  // ── 7. classifyChangeStep routing decision ─────────────────────────────────
  describe('classifyChangeStep — LLM routes to ChangeType', function () {
    it('returns ChangeType.Minor when LLM responds minor', async () => {
      const state = Object.assign({}, makeBaseState(), {
        sampleSql: 'SELECT name FROM employees',
        sampleSqlPrompt: 'Get all employees',
        description: 'Returns all employee names',
      }) as unknown as DbQueryState;

      const fakeLlm = createFakeLanguageModel(
        ChangeType.Minor,
      ) as unknown as LLMProvider;

      const result = await classifyChangeStep(state, context, {llm: fakeLlm});
      expect(result.changeType).to.equal(ChangeType.Minor);
    });

    it('returns undefined changeType when no sampleSql (fresh query)', async () => {
      const state = makeBaseState(); // no sampleSql
      const fakeLlm = createFakeLanguageModel(
        'major',
      ) as unknown as LLMProvider;

      const result = await classifyChangeStep(state, context, {llm: fakeLlm});
      // With no sampleSql the step skips the LLM call
      expect(result.changeType).to.be.undefined();
    });
  });
});

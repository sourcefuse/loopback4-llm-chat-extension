import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  buildImproveSqlPrompt,
  emitToolStatus,
  getChatLlm,
  getDatasetStore,
  getDbConnector,
  getGlobalContext,
  getSchemaStore,
  getTablesWithColumns,
  runSqlAttempt,
} from './_helpers';

const MAX_IMPROVE_ATTEMPTS = 3;

/**
 * Build the failure result the fix-query loop emits when load-existing
 * flagged a missing dataset / unbound DatasetStore. Extracted to keep
 * fixQueryStep.execute under SonarQube's cyclomatic threshold.
 */
function loadErrorShortCircuit(data: {
  datasetId?: string;
  prompt?: string;
  tables?: string[];
  checklist?: string;
  attempts?: number;
}) {
  return {
    datasetId: data.datasetId ?? '',
    sql: '',
    passed: false,
    attempts: (data.attempts ?? 0) + 1,
    feedback: 'Unable to load source dataset for improvement',
    description: undefined,
    prompt: data.prompt ?? '',
    tables: data.tables ?? [],
    checklist: data.checklist ?? '',
  };
}

/**
 * `improveQueryWorkflow` — improvement variant of `generateQueryWorkflow`.
 * Enters with an existing datasetId and a delta prompt, skips the
 * cache/templates fan-out, and dives straight into the validate-retry
 * loop. See the migration plan.
 *
 * Restore strategy for remaining stub bodies: lift v2 IsImprovement +
 * FixQuery + SaveDataset node bodies from
 * `git show 4be9767^:src/components/db-query/nodes/<name>.node.ts`.
 */

const inputSchema = z.object({
  datasetId: z.string(),
  prompt: z.string(),
});

const outputSchema = z.object({
  datasetId: z.string(),
  sql: z.string(),
  rowCount: z.number(),
});

/**
 * load-existing — wired. Resolves IDataSetStore via lb4Ctx, fetches the
 * dataset row, then merges the user's delta prompt onto the original
 * (mirroring v2 IsImprovementNode.execute at 4be9767^). When the
 * dataset is not found the step still completes with the inputData
 * verbatim so the downstream fix-query loop can produce a "failed"
 * outcome instead of crashing the run.
 */
const loadExistingStep = createStep({
  id: 'load-existing',
  inputSchema,
  outputSchema: z.object({
    datasetId: z.string(),
    prompt: z.string(),
    originalPrompt: z.string().optional(),
    originalSql: z.string().optional(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
    loadError: z.boolean().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const base = {
      datasetId: inputData.datasetId,
      prompt: inputData.prompt,
      originalPrompt: undefined as string | undefined,
      originalSql: undefined as string | undefined,
      tables: [] as string[],
      checklist: '',
      attempts: 0,
      loadError: false,
    };
    const store = getDatasetStore(requestContext);
    if (!store) return {...base, loadError: true};
    try {
      const dataset = await store.findById(inputData.datasetId);
      return {
        ...base,
        originalPrompt: dataset.prompt,
        originalSql: dataset.query,
        tables: dataset.tables ?? [],
        prompt: `${dataset.prompt}\n also consider following feedback given by user -\n ${inputData.prompt}\n`,
      };
    } catch {
      // findById rejected — 404 / RLS deny / connection drop indistinguishable
      // here. Flag loadError so the fixQuery loop short-circuits to failedStep
      // instead of asking the LLM to "improve" an empty originalSql.
      return {...base, loadError: true};
    }
  },
});

/**
 * fix-query — wired with LLM. dountil loop body that asks the chat
 * model to produce an improved SQL statement honouring the user's
 * delta prompt + the original query (forwarded via load-existing's
 * originalSql). Validator wiring still TODO — for now the step marks
 * passed=true on a successful LLM call so the loop exits after first
 * iteration. Validator restoration follows the same path as
 * sql-and-validate's TODO in generate.workflow.ts.
 */
const fixQueryStep = createStep({
  id: 'fix-query',
  inputSchema: z.any(),
  outputSchema: z.object({
    datasetId: z.string(),
    sql: z.string(),
    passed: z.boolean(),
    attempts: z.number(),
    feedback: z.string().optional(),
    description: z.string().optional(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
  }),
  execute: async ({inputData, requestContext}) => {
    emitToolStatus(
      requestContext,
      'fix-query',
      'Fixing SQL query based on validation errors',
    );
    const data = inputData as {
      datasetId?: string;
      prompt?: string;
      originalSql?: string;
      tables?: string[];
      checklist?: string;
      feedback?: string;
      attempts?: number;
      loadError?: boolean;
    };
    if (data.loadError) return loadErrorShortCircuit(data);
    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const columns = getTablesWithColumns(
      getSchemaStore(requestContext),
      tables,
    );
    const attempt = await runSqlAttempt({
      chatLlm: getChatLlm(requestContext),
      dbConnector: getDbConnector(requestContext),
      prompt,
      tables,
      columns,
      checks: getGlobalContext(requestContext),
      checklist: data.checklist,
      feedback: data.feedback,
      buildPrompt: buildImproveSqlPrompt,
      initialSql: data.originalSql,
    });
    return {
      datasetId: data.datasetId ?? '',
      sql: attempt.sql,
      passed: attempt.passed,
      attempts: (data.attempts ?? 0) + 1,
      feedback: attempt.feedback,
      description: undefined,
      prompt,
      tables,
      checklist: data.checklist ?? '',
    };
  },
});

/**
 * save-improved — wired. Updates the existing dataset row with the new
 * SQL produced by the dountil(fix-query) loop. No tenant check needed
 * since the row already belongs to the caller (load-existing resolved
 * it via findById which honours datasource RLS).
 */
const saveImprovedStep = createStep({
  id: 'save-improved',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      datasetId?: string;
      sql?: string;
      description?: string;
    };
    // FAIL shape: empty datasetId + empty sql. Consumers (UI, SSE
    // ToolStatus.Failed handlers) distinguish success from silent-
    // update-failure by checking datasetId presence.
    const failResult = {datasetId: '', sql: '', rowCount: 0};
    if (!data.datasetId || !data.sql) return failResult;
    const store = getDatasetStore(requestContext);
    if (!store) return failResult;
    // Build the patch defensively: only include `description` when the
    // upstream step produced one. Sending `description: undefined` against
    // a NOT NULL column (the default datasets.description shape) makes
    // some connectors (e.g. sqlite3) translate it to NULL and reject the
    // update — silently dropping the improvement.
    const patch: {query: string; description?: string} = {query: data.sql};
    if (data.description !== undefined) patch.description = data.description;
    try {
      await store.updateById(data.datasetId, patch);
    } catch {
      // Persisted update rejected. Return fail-shape so the SSE layer
      // surfaces it instead of echoing the requested sql as if saved.
      return failResult;
    }
    return {datasetId: data.datasetId, sql: data.sql, rowCount: 0};
  },
});

const failedStep = createStep({
  id: 'failed',
  inputSchema: z.any(),
  outputSchema,
  execute: async () => ({datasetId: '', sql: '', rowCount: 0}),
});

export const improveQueryWorkflow = createWorkflow({
  id: 'improve-query',
  inputSchema,
  outputSchema,
})
  .then(loadExistingStep)
  .dountil(
    fixQueryStep,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_IMPROVE_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedStep,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveImprovedStep,
    ],
  ])
  .commit();

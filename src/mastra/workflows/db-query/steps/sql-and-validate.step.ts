import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  buildGenerateSqlPrompt,
  emitToolStatus,
  getAllSchemaTables,
  getCheapLlm,
  getDbConnector,
  getDbQueryConfig,
  getGlobalContext,
  getSchemaStore,
  getSmartLlm,
  getTablesWithColumns,
  runSqlAttempt,
  shouldUseCheapForSqlGen,
} from '../_helpers';
import {MAX_VALIDATION_ATTEMPTS, STEP_SQL_AND_VALIDATE} from './constants';

function cachedSqlPassthrough(data: {
  attempts?: number;
  cached?: boolean;
  datasetId?: string;
  sql?: string;
}) {
  if (!(data.cached && data.datasetId)) return null;
  return {
    sql: data.sql ?? '',
    passed: true,
    attempts: (data.attempts ?? 0) + 1,
    feedback: undefined,
    description: '',
    prompt: '',
    tables: [] as string[],
    checklist: '',
    cached: true,
    datasetId: data.datasetId,
  };
}

// The get-columns gate judged the question unanswerable. Exit the dountil
// immediately (attempts forced to the cap, passed=false) so NO smart-tier
// SQL generation runs and the final branch routes to failedStep, which
// surfaces `replyToUser`.
function unanswerableShortCircuit(data: {
  unanswerable?: boolean;
  replyToUser?: string;
  prompt?: string;
}) {
  if (!data.unanswerable) return null;
  return {
    sql: '',
    passed: false,
    attempts: MAX_VALIDATION_ATTEMPTS,
    feedback: undefined,
    description: '',
    prompt: data.prompt ?? '',
    tables: [] as string[],
    checklist: '',
    unanswerable: true,
    replyToUser: data.replyToUser ?? '',
  };
}

function sqlStatusEmitters(
  requestContext: Parameters<typeof emitToolStatus>[0],
) {
  return {
    onReselectTables: () =>
      emitToolStatus(
        requestContext,
        STEP_SQL_AND_VALIDATE,
        'Reselecting tables to resolve a missing table or column',
      ),
    onStatus: (stage: 'syntactic' | 'semantic') =>
      emitToolStatus(
        requestContext,
        STEP_SQL_AND_VALIDATE,
        stage === 'syntactic'
          ? 'Validating generated SQL query'
          : "Verifying if the query fully satisfies the user's requirement",
      ),
  };
}

export const sqlAndValidateStep = createStep({
  id: STEP_SQL_AND_VALIDATE,
  inputSchema: z.any(),
  outputSchema: z.object({
    sql: z.string(),
    passed: z.boolean(),
    attempts: z.number(),
    feedback: z.string().optional(),
    description: z.string(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
    cached: z.boolean().optional(),
    datasetId: z.string().optional(),
    unanswerable: z.boolean().optional(),
    replyToUser: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, tracingContext}) => {
    const data = inputData as {
      prompt?: string;
      tables?: string[];
      checklist?: string;
      feedback?: string;
      attempts?: number;
      cached?: boolean;
      datasetId?: string;
      sql?: string;
      unanswerable?: boolean;
      replyToUser?: string;
    };

    const cached = cachedSqlPassthrough(data);
    if (cached) return cached;

    const blocked = unanswerableShortCircuit(data);
    if (blocked) return blocked;

    emitToolStatus(
      requestContext,
      STEP_SQL_AND_VALIDATE,
      'Generating SQL query from the prompt',
    );

    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const schemaStore = getSchemaStore(requestContext);

    // Tier selection (restores v2 cost optimisation): retries and
    // single-table queries run on the cheap tier; multi-table first attempts
    // on smart.
    const isRetry = (data.attempts ?? 0) > 0;
    const useCheap = shouldUseCheapForSqlGen(
      getDbQueryConfig(requestContext),
      tables.length,
      isRetry,
    );
    const genLlm = useCheap
      ? getCheapLlm(requestContext)
      : getSmartLlm(requestContext);

    const attempt = await runSqlAttempt({
      chatLlm: genLlm,
      cheapLlm: getCheapLlm(requestContext),
      allTables: getAllSchemaTables(schemaStore),
      tracing: tracingContext,
      dbConnector: getDbConnector(requestContext),
      prompt,
      tables,
      columns: getTablesWithColumns(schemaStore, tables),
      checks: getGlobalContext(requestContext),
      checklist: data.checklist,
      feedback: data.feedback,
      buildPrompt: buildGenerateSqlPrompt,
      buildDescription: (_sql, p) => `Generated SQL for: ${p}`,
      lastAttempt: (data.attempts ?? 0) + 1 >= MAX_VALIDATION_ATTEMPTS,
      ...sqlStatusEmitters(requestContext),
    });

    return {
      sql: attempt.sql,
      passed: attempt.passed,
      attempts: (data.attempts ?? 0) + 1,
      feedback: attempt.feedback,
      description: attempt.description ?? '',
      prompt,
      tables: attempt.tables ?? tables,
      checklist: data.checklist ?? '',
    };
  },
});

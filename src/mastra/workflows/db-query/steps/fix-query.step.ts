import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  buildImproveSqlPrompt,
  emitToolStatus,
  getAllSchemaTables,
  getCheapLlm,
  getDbConnector,
  getGlobalContext,
  getSchemaStore,
  getSmartLlm,
  getTablesWithColumns,
  runSqlAttempt,
} from '../_helpers';
import {loadErrorShortCircuit} from './improve.shared';

export const fixQueryStep = createStep({
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
  execute: async ({inputData, requestContext, tracingContext}) => {
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
    const schemaStore = getSchemaStore(requestContext);
    const columns = getTablesWithColumns(schemaStore, tables);

    const attempt = await runSqlAttempt({
      chatLlm: getSmartLlm(requestContext),
      cheapLlm: getCheapLlm(requestContext),
      allTables: getAllSchemaTables(schemaStore),
      tracing: tracingContext,
      dbConnector: getDbConnector(requestContext),
      prompt,
      tables,
      columns,
      checks: getGlobalContext(requestContext),
      checklist: data.checklist,
      feedback: data.feedback,
      buildPrompt: buildImproveSqlPrompt,
      initialSql: data.originalSql,
      onReselectTables: () =>
        emitToolStatus(
          requestContext,
          'fix-query',
          'Reselecting tables to resolve a missing table or column',
        ),
    });

    return {
      datasetId: data.datasetId ?? '',
      sql: attempt.sql,
      passed: attempt.passed,
      attempts: (data.attempts ?? 0) + 1,
      feedback: attempt.feedback,
      description: undefined,
      prompt,
      tables: attempt.tables ?? tables,
      checklist: data.checklist ?? '',
    };
  },
});

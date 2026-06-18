import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
  getDbConnector,
  getDbQueryConfig,
  getSchemaForPrompt,
  getSchemaStore,
  getTablesWithColumns,
  logStepDetail,
  pickRelevantTables,
} from '../_helpers';
import {STEP_GET_COLUMNS} from './constants';

export const getColumnsStep = createStep({
  id: STEP_GET_COLUMNS,
  inputSchema: z.any(),
  outputSchema: z.object({
    prompt: z.string(),
    tables: z.array(z.string()),
    templateId: z.string().optional(),
    // Set when the LLM judges the question cannot be answered from any
    // available table. Downstream steps short-circuit to the failed
    // terminal WITHOUT generating SQL; `replyToUser` is surfaced to the user.
    unanswerable: z.boolean().optional(),
    replyToUser: z.string().optional(),
    // Worked-example query from a "Similar" cache hit, carried to SQL gen.
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, tracingContext}) => {
    emitToolStatus(
      requestContext,
      STEP_GET_COLUMNS,
      'Extracting relevant columns from the schema',
    );

    const data = inputData as {
      prompt?: string;
      tables?: string[];
      templateId?: string;
      sampleSql?: string;
      samplePrompt?: string;
    };
    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const templateId = data.templateId;
    const sample = {sampleSql: data.sampleSql, samplePrompt: data.samplePrompt};

    const chatLlm = getCheapLlm(requestContext);
    if (!chatLlm || tables.length === 0) {
      return {prompt, tables, templateId, ...sample};
    }

    const schemaStore = getSchemaStore(requestContext);
    const tablesWithColumns = getTablesWithColumns(schemaStore, tables);
    const picked = await pickRelevantTables({
      chatLlm,
      tracing: tracingContext,
      prompt,
      tablesWithColumns,
      schema: getSchemaForPrompt(
        schemaStore,
        getDbConnector(requestContext),
        tables,
      ),
      upstreamTables: tables,
    });

    // Early gate (restores v2 get-tables' fast-fail): an unanswerable
    // question stops here instead of falling through to the expensive
    // SQL-generation/validation loop.
    if (picked.kind === 'unanswerable') {
      logStepDetail(STEP_GET_COLUMNS, `Unanswerable: ${picked.reason}`);
      return {
        prompt,
        tables: [],
        templateId,
        unanswerable: true,
        replyToUser: picked.reason,
      };
    }

    // Apply the LLM-picked subset ONLY when `columnSelection` is enabled.
    // With it off (the default), keep ALL upstream tables so a lookup table the
    // picker might omit (e.g. `exchange_rates`, needed for currency conversion)
    // is never dropped before SQL generation — dropping it silently produces
    // wrong, unconverted results on wide schemas. `true` narrows the schema to
    // keep the SQL-gen prompt small on very wide schemas (see
    // `DbQueryConfig.columnSelection`). `unknown` (no LLM / empty schema /
    // parse error) always keeps the full upstream set.
    const columnSelection = getDbQueryConfig(requestContext)?.columnSelection;
    const tablesOut =
      columnSelection && picked.kind === 'tables' ? picked.tables : tables;
    logStepDetail(STEP_GET_COLUMNS, `Selected tables: ${tablesOut.join(', ')}`);
    return {prompt, tables: tablesOut, templateId, ...sample};
  },
});

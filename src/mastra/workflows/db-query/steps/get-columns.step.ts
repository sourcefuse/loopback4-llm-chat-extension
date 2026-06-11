import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
  getDbConnector,
  getSchemaForPrompt,
  getSchemaStore,
  getTablesWithColumns,
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
      return {
        prompt,
        tables: [],
        templateId,
        unanswerable: true,
        replyToUser: picked.reason,
      };
    }

    // `unknown` (no LLM, empty schema, or LLM/parse error) is NOT a verdict
    // of unanswerability — keep the full upstream set and proceed.
    const tablesOut = picked.kind === 'tables' ? picked.tables : tables;
    return {prompt, tables: tablesOut, templateId, ...sample};
  },
});

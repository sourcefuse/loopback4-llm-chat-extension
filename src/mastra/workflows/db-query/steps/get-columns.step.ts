import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
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
    };
    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const templateId = data.templateId;

    const chatLlm = getCheapLlm(requestContext);
    if (!chatLlm || tables.length === 0) {
      return {prompt, tables, templateId};
    }

    const tablesWithColumns = getTablesWithColumns(
      getSchemaStore(requestContext),
      tables,
    );
    const narrowed = await pickRelevantTables({
      chatLlm,
      tracing: tracingContext,
      prompt,
      tablesWithColumns,
      upstreamTables: tables,
    });

    return {prompt, tables: narrowed ?? tables, templateId};
  },
});

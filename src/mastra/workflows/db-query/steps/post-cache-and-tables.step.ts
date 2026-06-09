import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  classifyPostCacheStatus,
  STEP_CHECK_CACHE,
  STEP_CHECK_TEMPLATES,
  STEP_GET_TABLES,
} from './constants';

export const postCacheAndTablesStep = createStep({
  id: 'post-cache-and-tables',
  inputSchema: z.any(),
  outputSchema: z.object({
    fromCache: z.boolean(),
    fromTemplate: z.boolean(),
    status: z.enum(['AsIs', 'FromTemplate', 'Failed', 'Continue']),
    tables: z.array(z.string()),
    templateId: z.string().optional(),
    datasetId: z.string().optional(),
    prompt: z.string(),
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
  execute: async ({getStepResult, getInitData, inputData}) => {
    const cache = (getStepResult(STEP_CHECK_CACHE) ?? {cacheHit: false}) as {
      cacheHit: boolean;
      datasetId?: string;
      sampleSql?: string;
      samplePrompt?: string;
    };
    const tables = (getStepResult(STEP_GET_TABLES) ?? {tables: []}) as {
      tables: string[];
    };
    const templates = (getStepResult(STEP_CHECK_TEMPLATES) ?? {
      matched: false,
    }) as {matched: boolean; templateId?: string};

    const init = (getInitData?.() ?? {}) as {prompt?: string};
    const prompt =
      init.prompt ?? (inputData as {prompt?: string})?.prompt ?? '';

    return {
      fromCache: cache.cacheHit,
      fromTemplate: templates.matched,
      status: classifyPostCacheStatus(cache.cacheHit, templates.matched),
      tables: tables.tables,
      templateId: templates.templateId,
      datasetId: cache.datasetId,
      prompt,
      sampleSql: cache.sampleSql,
      samplePrompt: cache.samplePrompt,
    };
  },
});

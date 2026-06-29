import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {makeStepShell} from '../../../runtime/_step-shell';
import {
  MAX_VALIDATION_ATTEMPTS,
  STEP_CHECK_CACHE,
  STEP_CHECK_TEMPLATES,
  STEP_FAILED,
  STEP_GENERATE_CHECKLIST,
  STEP_GET_COLUMNS,
  STEP_GET_TABLES,
  STEP_POST_CACHE_AND_TABLES,
  STEP_RETURN_CACHED,
  STEP_SAVE_DATASET,
  STEP_SAVE_FROM_TEMPLATE,
  STEP_SQL_AND_VALIDATE,
  STEP_VERIFY_CHECKLIST,
  branchCachedSchema,
  branchContinueSchema,
  branchTemplateSchema,
  inputSchema,
  outputSchema,
} from '../steps/constants';
import {checklistStateSchema} from '../steps/checklist.shared';

// Step shells — the Mastra-named equivalent of LangGraph's
// `addNode(key, getNodeFn(key))`: each shell fixes a step's id + schemas at
// build time and delegates to the `@step(key)` class resolved from the LB4
// container at run time (see ../steps + WorkflowRunner.resolveWorkflowStep).
// Exported so the advanced "recompose a workflow" path can reuse them.
export const checkCacheStep = makeStepShell({
  id: STEP_CHECK_CACHE,
  inputSchema,
  outputSchema: z.object({
    cacheHit: z.boolean(),
    datasetId: z.string().optional(),
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
});
export const getTablesStep = makeStepShell({
  id: STEP_GET_TABLES,
  inputSchema,
  outputSchema: z.object({tables: z.array(z.string())}),
});
export const checkTemplatesStep = makeStepShell({
  id: STEP_CHECK_TEMPLATES,
  inputSchema,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
});
export const postCacheAndTablesStep = makeStepShell({
  id: STEP_POST_CACHE_AND_TABLES,
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
});
export const returnCachedStep = makeStepShell({
  id: STEP_RETURN_CACHED,
  inputSchema: z.any(),
  outputSchema: branchCachedSchema,
});
export const saveDatasetFromTemplateStep = makeStepShell({
  id: STEP_SAVE_FROM_TEMPLATE,
  inputSchema: z.any(),
  outputSchema: branchTemplateSchema,
});
export const getColumnsStep = makeStepShell({
  id: STEP_GET_COLUMNS,
  inputSchema: z.any(),
  outputSchema: branchContinueSchema,
});
export const generateChecklistStep = makeStepShell({
  id: STEP_GENERATE_CHECKLIST,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: checklistStateSchema,
});
export const verifyChecklistStep = makeStepShell({
  id: STEP_VERIFY_CHECKLIST,
  inputSchema: checklistStateSchema,
  outputSchema: checklistStateSchema,
});
export const sqlAndValidateStep = makeStepShell({
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
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
});
export const saveDatasetStep = makeStepShell({
  id: STEP_SAVE_DATASET,
  inputSchema: z.any(),
  outputSchema,
});
export const failedStep = makeStepShell({
  id: STEP_FAILED,
  inputSchema: z.any(),
  outputSchema,
});

export const generateQueryWorkflow = createWorkflow({
  id: 'generate-query',
  inputSchema,
  outputSchema,
})
  .parallel([checkCacheStep, getTablesStep, checkTemplatesStep])
  .then(postCacheAndTablesStep)
  .branch([
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'FromTemplate',
      saveDatasetFromTemplateStep,
    ],
    [
      async ({inputData}) => (inputData as {status?: string}).status === 'AsIs',
      returnCachedStep,
    ],
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'Continue',
      getColumnsStep,
    ],
  ])
  .then(generateChecklistStep)
  .then(verifyChecklistStep)
  .dountil(
    sqlAndValidateStep,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_VALIDATION_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedStep,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveDatasetStep,
    ],
  ])
  .commit();

import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {makeNodeShell} from '../../../runtime/_node-shell';
import {
  MAX_VALIDATION_ATTEMPTS,
  branchCachedSchema,
  branchContinueSchema,
  branchTemplateSchema,
  inputSchema,
  outputSchema,
} from '../constants';
import {DbQueryNodes} from '../nodes.enum';
import {checklistStateSchema} from '../checklist.shared';

// Step shells — the Mastra-named equivalent of LangGraph's
// `addNode(key, getNodeFn(key))`: each shell fixes a step's id + schemas at
// build time and delegates to the `@graphNode(key)` class resolved from the LB4
// container at run time (see ../steps + WorkflowRunner.resolveGraphNode).
// Exported so the advanced "recompose a workflow" path can reuse them.
export const checkCacheNode = makeNodeShell({
  id: DbQueryNodes.CheckCache,
  inputSchema,
  outputSchema: z.object({
    cacheHit: z.boolean(),
    datasetId: z.string().optional(),
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
});
export const getTablesNode = makeNodeShell({
  id: DbQueryNodes.GetTables,
  inputSchema,
  outputSchema: z.object({tables: z.array(z.string())}),
});
export const checkTemplatesNode = makeNodeShell({
  id: DbQueryNodes.CheckTemplates,
  inputSchema,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
});
export const postCacheAndTablesNode = makeNodeShell({
  id: DbQueryNodes.PostCacheAndTables,
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
export const returnCachedNode = makeNodeShell({
  id: DbQueryNodes.ReturnCached,
  inputSchema: z.any(),
  outputSchema: branchCachedSchema,
});
export const saveDatasetFromTemplateNode = makeNodeShell({
  id: DbQueryNodes.SaveFromTemplate,
  inputSchema: z.any(),
  outputSchema: branchTemplateSchema,
});
export const getColumnsNode = makeNodeShell({
  id: DbQueryNodes.GetColumns,
  inputSchema: z.any(),
  outputSchema: branchContinueSchema,
});
export const generateChecklistNode = makeNodeShell({
  id: DbQueryNodes.GenerateChecklist,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: checklistStateSchema,
});
export const verifyChecklistNode = makeNodeShell({
  id: DbQueryNodes.VerifyChecklist,
  inputSchema: checklistStateSchema,
  outputSchema: checklistStateSchema,
});
export const sqlAndValidateNode = makeNodeShell({
  id: DbQueryNodes.SqlAndValidate,
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
export const saveDatasetNode = makeNodeShell({
  id: DbQueryNodes.SaveDataset,
  inputSchema: z.any(),
  outputSchema,
});
export const failedNode = makeNodeShell({
  id: DbQueryNodes.Failed,
  inputSchema: z.any(),
  outputSchema,
});

export const generateQueryWorkflow = createWorkflow({
  id: 'generate-query',
  inputSchema,
  outputSchema,
})
  .parallel([checkCacheNode, getTablesNode, checkTemplatesNode])
  .then(postCacheAndTablesNode)
  .branch([
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'FromTemplate',
      saveDatasetFromTemplateNode,
    ],
    [
      async ({inputData}) => (inputData as {status?: string}).status === 'AsIs',
      returnCachedNode,
    ],
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'Continue',
      getColumnsNode,
    ],
  ])
  .then(generateChecklistNode)
  .then(verifyChecklistNode)
  .dountil(
    sqlAndValidateNode,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_VALIDATION_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedNode,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveDatasetNode,
    ],
  ])
  .commit();

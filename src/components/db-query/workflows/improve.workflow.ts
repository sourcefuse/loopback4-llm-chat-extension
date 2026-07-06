import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {makeNodeShell} from '../../../runtime/_node-shell';
import {DbQueryNodes} from '../nodes.enum';
import {
  MAX_IMPROVE_ATTEMPTS,
  improveInputSchema,
  improveOutputSchema,
} from '../improve.shared';

// Step shells for the improve workflow — see generate.workflow.ts for the
// shell/DI pattern. The improve terminal step keeps the Mastra id 'failed'
// (DbQueryNodes.Failed) within this workflow but resolves under the globally-unique DI
// key 'improve-failed' (DbQueryNodes.ImproveFailed).
export const loadExistingNode = makeNodeShell({
  id: DbQueryNodes.LoadExisting,
  inputSchema: improveInputSchema,
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
});
export const fixQueryNode = makeNodeShell({
  id: DbQueryNodes.FixQuery,
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
});
export const saveImprovedNode = makeNodeShell({
  id: DbQueryNodes.SaveImproved,
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
});
export const improveFailedNode = makeNodeShell({
  id: DbQueryNodes.Failed,
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
  resolverKey: DbQueryNodes.ImproveFailed,
});

export const improveQueryWorkflow = createWorkflow({
  id: 'improve-query',
  inputSchema: improveInputSchema,
  outputSchema: improveOutputSchema,
})
  .then(loadExistingNode)
  .dountil(
    fixQueryNode,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_IMPROVE_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      improveFailedNode,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveImprovedNode,
    ],
  ])
  .commit();

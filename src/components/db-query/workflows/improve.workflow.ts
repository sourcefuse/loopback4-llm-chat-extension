import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {makeStepShell} from '../../../runtime/_step-shell';
import {
  STEP_FAILED,
  STEP_FIX_QUERY,
  STEP_IMPROVE_FAILED,
  STEP_LOAD_EXISTING,
  STEP_SAVE_IMPROVED,
} from '../steps/constants';
import {
  MAX_IMPROVE_ATTEMPTS,
  improveInputSchema,
  improveOutputSchema,
} from '../steps/improve.shared';

// Step shells for the improve workflow — see generate.workflow.ts for the
// shell/DI pattern. The improve terminal step keeps the Mastra id 'failed'
// (STEP_FAILED) within this workflow but resolves under the globally-unique DI
// key 'improve-failed' (STEP_IMPROVE_FAILED).
export const loadExistingStep = makeStepShell({
  id: STEP_LOAD_EXISTING,
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
export const fixQueryStep = makeStepShell({
  id: STEP_FIX_QUERY,
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
export const saveImprovedStep = makeStepShell({
  id: STEP_SAVE_IMPROVED,
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
});
export const improveFailedStep = makeStepShell({
  id: STEP_FAILED,
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
  resolverKey: STEP_IMPROVE_FAILED,
});

export const improveQueryWorkflow = createWorkflow({
  id: 'improve-query',
  inputSchema: improveInputSchema,
  outputSchema: improveOutputSchema,
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
      improveFailedStep,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveImprovedStep,
    ],
  ])
  .commit();

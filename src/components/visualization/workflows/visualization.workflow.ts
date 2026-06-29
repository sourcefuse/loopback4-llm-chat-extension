import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {makeStepShell} from '../../../runtime/_step-shell';
import {
  STEP_CALL_QUERY_GENERATION,
  STEP_GET_DATASET_DATA,
  STEP_RENDER_VISUALIZATION,
  STEP_SELECT_VISUALISATION,
  visualizationInputSchema,
  visualizationOutputSchema,
} from '../steps/shared';

const selectionOutputSchema = z.object({
  datasetId: z.string(),
  needsQuery: z.boolean(),
  chartType: z.string(),
  userQuery: z.string(),
  rejected: z.boolean().optional(),
  reason: z.string().optional(),
});

// Step shells — delegate to the `@step(key)` classes in ../steps (see
// generate.workflow.ts for the shell/DI pattern).
export const selectVisualisationStep = makeStepShell({
  id: STEP_SELECT_VISUALISATION,
  inputSchema: z.object({
    datasetId: z.string(),
    userQuery: z.string(),
    type: z.string().optional(),
  }),
  outputSchema: selectionOutputSchema,
});
export const callQueryGenerationStep = makeStepShell({
  id: STEP_CALL_QUERY_GENERATION,
  inputSchema: selectionOutputSchema,
  outputSchema: selectionOutputSchema,
});
export const getDatasetDataStep = makeStepShell({
  id: STEP_GET_DATASET_DATA,
  inputSchema: z.any(),
  outputSchema: z.object({
    datasetId: z.string(),
    rows: z.array(z.unknown()),
    chartType: z.string(),
    userQuery: z.string(),
    sql: z.string().optional(),
    description: z.string().optional(),
    rejected: z.boolean().optional(),
    reason: z.string().optional(),
  }),
});
export const renderVisualizationStep = makeStepShell({
  id: STEP_RENDER_VISUALIZATION,
  inputSchema: z.object({
    datasetId: z.string(),
    rows: z.array(z.unknown()),
    chartType: z.string(),
    userQuery: z.string(),
    sql: z.string().optional(),
    description: z.string().optional(),
    rejected: z.boolean().optional(),
    reason: z.string().optional(),
  }),
  outputSchema: visualizationOutputSchema,
});

export const visualizationWorkflow = createWorkflow({
  id: 'visualization',
  inputSchema: visualizationInputSchema,
  outputSchema: visualizationOutputSchema,
})
  .then(selectVisualisationStep)
  .then(callQueryGenerationStep)
  .then(getDatasetDataStep)
  .then(renderVisualizationStep)
  .commit();

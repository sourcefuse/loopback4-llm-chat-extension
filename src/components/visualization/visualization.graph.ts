import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {makeNodeShell} from '../../runtime/_node-shell';
import {visualizationInputSchema, visualizationOutputSchema} from './shared';
import {VisualizationGraphNodes} from './nodes.enum';

const selectionOutputSchema = z.object({
  datasetId: z.string(),
  needsQuery: z.boolean(),
  chartType: z.string(),
  userQuery: z.string(),
  rejected: z.boolean().optional(),
  reason: z.string().optional(),
});

// Step shells — delegate to the `@graphNode(key)` classes in ../steps (see
// generate.workflow.ts for the shell/DI pattern).
export const selectVisualisationNode = makeNodeShell({
  id: VisualizationGraphNodes.SelectVisualisation,
  inputSchema: z.object({
    datasetId: z.string(),
    userQuery: z.string(),
    type: z.string().optional(),
  }),
  outputSchema: selectionOutputSchema,
});
export const callQueryGenerationNode = makeNodeShell({
  id: VisualizationGraphNodes.CallQueryGeneration,
  inputSchema: selectionOutputSchema,
  outputSchema: selectionOutputSchema,
});
export const getDatasetDataNode = makeNodeShell({
  id: VisualizationGraphNodes.GetDatasetData,
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
export const renderVisualizationNode = makeNodeShell({
  id: VisualizationGraphNodes.RenderVisualization,
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

export const visualizationGraph = createWorkflow({
  id: 'visualization',
  inputSchema: visualizationInputSchema,
  outputSchema: visualizationOutputSchema,
})
  .then(selectVisualisationNode)
  .then(callQueryGenerationNode)
  .then(getDatasetDataNode)
  .then(renderVisualizationNode)
  .commit();

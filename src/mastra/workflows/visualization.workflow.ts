import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';

/**
 * `visualizationWorkflow` — Mastra port of the 4-node VisualizationGraph.
 * Linear DAG with one branch: when `needsQuery` is true the workflow
 * runs the query-generation step before fetching dataset rows; otherwise
 * it pulls cached dataset rows directly. Either branch then dispatches
 * to the visualizer registry via renderVisualizationStep.
 *
 * See MIGRATION-STRATEGY.md Section 9.3. P3 scope: skeleton only.
 */

const inputSchema = z.object({
  datasetId: z.string(),
  userQuery: z.string(),
});

const outputSchema = z.object({
  chartConfig: z.unknown(),
});

const selectVisualisationStep = createStep({
  id: 'select-visualisation',
  inputSchema,
  outputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
  }),
  execute: async ({inputData}) => ({
    datasetId: inputData.datasetId,
    needsQuery: false,
    chartType: 'bar',
  }),
});

const callQueryGenerationStep = createStep({
  id: 'call-query-generation',
  inputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
  }),
  outputSchema: z.object({datasetId: z.string(), chartType: z.string()}),
  execute: async ({inputData}) => ({
    datasetId: inputData.datasetId,
    chartType: inputData.chartType,
  }),
});

const getDatasetDataStep = createStep({
  id: 'get-dataset-data',
  inputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    rows: z.array(z.unknown()),
    chartType: z.string(),
  }),
  execute: async ({inputData}) => ({
    datasetId: inputData.datasetId,
    rows: [],
    chartType: inputData.chartType,
  }),
});

const renderVisualizationStep = createStep({
  id: 'render-visualization',
  inputSchema: z.any(),
  outputSchema,
  execute: async () => ({chartConfig: {}}),
});

export const visualizationWorkflow = createWorkflow({
  id: 'visualization',
  inputSchema,
  outputSchema,
})
  .then(selectVisualisationStep)
  .branch([
    [
      async ({inputData}) =>
        (inputData as {needsQuery?: boolean}).needsQuery === true,
      callQueryGenerationStep,
    ],
    [async () => true, getDatasetDataStep],
  ])
  .then(renderVisualizationStep)
  .commit();

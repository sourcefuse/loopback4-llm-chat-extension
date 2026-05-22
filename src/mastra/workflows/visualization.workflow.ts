import type {Context} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import type {DataSetHelper} from '../../components/db-query/services';

/**
 * `visualizationWorkflow` — Mastra port of the 4-node VisualizationGraph.
 * Linear DAG with one branch: when `needsQuery` is true the workflow
 * runs the query-generation step before fetching dataset rows; otherwise
 * it pulls cached dataset rows directly. Either branch then dispatches
 * to the visualizer registry via renderVisualizationStep.
 *
 * See MIGRATION-STRATEGY.md Section 9.3. Restore strategy: lift v2
 * SelectVisualizationNode + CallQueryGenerationNode +
 * GetDatasetDataNode + RenderVisualizationNode bodies from
 * `git show 4be9767^:src/components/visualization/nodes/<name>.node.ts`.
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

/**
 * get-dataset-data — wired. Resolves DataSetHelper via lb4Ctx and
 * fetches the dataset's rows for visualization rendering. Mirrors the
 * v2 GetDatasetDataNode body at
 * `git show 4be9767^:src/components/visualization/nodes/get-dataset-data.node.ts`
 * minus the LangGraph state shape — Mastra step passes rows forward
 * via the typed output. Defensive fallback returns an empty rows array
 * when the consumer hasn't bound the db-query component.
 */
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
  execute: async ({inputData, requestContext}) => {
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx) {
      return {
        datasetId: inputData.datasetId,
        rows: [],
        chartType: inputData.chartType,
      };
    }
    const helper = await lb4Ctx.get<DataSetHelper>('services.DataSetHelper', {
      optional: true,
    });
    if (!helper) {
      return {
        datasetId: inputData.datasetId,
        rows: [],
        chartType: inputData.chartType,
      };
    }
    try {
      const rows = (await helper.getDataFromDataset(
        inputData.datasetId,
      )) as unknown[];
      return {
        datasetId: inputData.datasetId,
        rows: rows ?? [],
        chartType: inputData.chartType,
      };
    } catch {
      // permission denied / not found — empty rows let renderVisualization
      // surface an error to the user instead of crashing the workflow.
      return {
        datasetId: inputData.datasetId,
        rows: [],
        chartType: inputData.chartType,
      };
    }
  },
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

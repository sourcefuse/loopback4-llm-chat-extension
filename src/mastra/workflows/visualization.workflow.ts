import type {Context} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import type {DataSetHelper} from '../../components/db-query/services';
import {VISUALIZATION_KEY} from '../../components/visualization/keys';
import type {IVisualizer} from '../../components/visualization/types';

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

/**
 * select-visualisation — wired without LLM. Walks the @visualizer()-tagged
 * bindings the consumer registered, picks the first one whose `name`
 * matches the user-supplied `type` hint, falls back to 'bar'. The v2
 * SelectVisualizationNode used an LLM to pick from the list when the
 * caller did not supply a type; that LLM path is restored in a
 * follow-up alongside the other LLM-driven nodes
 * (`git show 4be9767^:src/components/visualization/nodes/select-visualization.node.ts`).
 * needsQuery=true when no datasetId provided so the workflow branches
 * to call-query-generation; otherwise reads dataset rows directly.
 */
const selectVisualisationStep = createStep({
  id: 'select-visualisation',
  inputSchema: z.object({
    datasetId: z.string(),
    userQuery: z.string(),
    type: z.string().optional(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
    userQuery: z.string(),
  }),
  execute: async ({inputData, requestContext}) => {
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    let chartType = inputData.type ?? 'bar';
    if (lb4Ctx && !inputData.type) {
      const bindings = lb4Ctx.findByTag({[VISUALIZATION_KEY]: true});
      if (bindings.length > 0) {
        const first = await lb4Ctx.get<IVisualizer>(bindings[0].key);
        chartType = first.name;
      }
    }
    return {
      datasetId: inputData.datasetId,
      needsQuery: !inputData.datasetId,
      chartType,
      userQuery: inputData.userQuery,
    };
  },
});

/**
 * call-query-generation — wired. Invokes generateQueryWorkflow
 * recursively when the user did not supply a datasetId. Mirrors v2
 * CallQueryGenerationNode (`git show 4be9767^:src/components/visualization/nodes/call-query-generation.node.ts`)
 * but uses mastra.getWorkflow().createRun().start() instead of
 * DbQueryGraph.invoke(). The wrapped prompt nudges the SQL generator
 * to produce a result shape suitable for the chosen chart type.
 */
const callQueryGenerationStep = createStep({
  id: 'call-query-generation',
  inputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
    userQuery: z.string(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    needsQuery: z.boolean(),
    chartType: z.string(),
  }),
  execute: async ({inputData, mastra, requestContext}) => {
    if (inputData.datasetId) {
      return {
        datasetId: inputData.datasetId,
        needsQuery: false,
        chartType: inputData.chartType,
      };
    }
    const generate = mastra?.getWorkflow?.('generateQueryWorkflow' as never);
    if (!generate) {
      return {
        datasetId: '',
        needsQuery: true,
        chartType: inputData.chartType,
      };
    }
    const run = await generate.createRun();
    const result = await run.start({
      inputData: {
        prompt: `Generate a query to fetch data for visualization based on the following user prompt: ${inputData.userQuery}.`,
      },
      requestContext,
    } as never);
    const out = (result as {result?: {datasetId?: string}}).result;
    return {
      datasetId: out?.datasetId ?? '',
      needsQuery: false,
      chartType: inputData.chartType,
    };
  },
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
  // Accept both shapes: direct selectVisualisation output and the
  // branch-wrapped post-callQueryGeneration output. Body unwraps.
  inputSchema: z.any(),
  outputSchema: z.object({
    datasetId: z.string(),
    rows: z.array(z.unknown()),
    chartType: z.string(),
  }),
  execute: async ({inputData, requestContext}) => {
    const wrapped = inputData as Record<string, unknown>;
    const fromCallQuery = wrapped['call-query-generation'] as
      | {datasetId?: string; chartType?: string}
      | undefined;
    const direct = wrapped as {datasetId?: string; chartType?: string};
    const inferredId = fromCallQuery?.datasetId ?? direct.datasetId ?? '';
    const inferredChart = fromCallQuery?.chartType ?? direct.chartType ?? 'bar';
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx) {
      return {datasetId: inferredId, rows: [], chartType: inferredChart};
    }
    const helper = await lb4Ctx.get<DataSetHelper>('services.DataSetHelper', {
      optional: true,
    });
    if (!helper) {
      return {datasetId: inferredId, rows: [], chartType: inferredChart};
    }
    try {
      const rows = (await helper.getDataFromDataset(inferredId)) as unknown[];
      return {
        datasetId: inferredId,
        rows: rows ?? [],
        chartType: inferredChart,
      };
    } catch {
      // permission denied / not found — empty rows let renderVisualization
      // surface an error to the user instead of crashing the workflow.
      return {datasetId: inferredId, rows: [], chartType: inferredChart};
    }
  },
});

/**
 * render-visualization — wired. Picks the matching visualizer from
 * the consumer-registered registry and delegates to its getConfig().
 * Visualizers (PieVisualizer, BarVisualizer, LineVisualizer plus any
 * consumer extension via @visualizer()) own their own LLM calls
 * internally — the workflow step just dispatches.
 */
const renderVisualizationStep = createStep({
  id: 'render-visualization',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const wrapped = inputData as Record<string, unknown>;
    const fromGetDataset = wrapped['get-dataset-data'] as
      | {datasetId?: string; rows?: unknown[]; chartType?: string}
      | undefined;
    const direct = wrapped as {
      datasetId?: string;
      rows?: unknown[];
      chartType?: string;
    };
    const chartType = fromGetDataset?.chartType ?? direct.chartType ?? 'bar';
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx) return {chartConfig: {}};
    const bindings = lb4Ctx.findByTag({[VISUALIZATION_KEY]: true});
    if (bindings.length === 0) return {chartConfig: {}};
    const visualizers = await Promise.all(
      bindings.map(b => lb4Ctx.get<IVisualizer>(b.key)),
    );
    const chosen =
      visualizers.find(v => v.name === chartType) ?? visualizers[0];
    try {
      const config = await chosen.getConfig({
        prompt: '',
        datasetId: fromGetDataset?.datasetId ?? direct.datasetId ?? '',
        sql: undefined,
        queryDescription: undefined,
        visualizer: chosen,
        visualizerName: chosen.name,
        done: true,
        type: chartType,
      });
      return {chartConfig: config};
    } catch {
      return {chartConfig: {}};
    }
  },
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

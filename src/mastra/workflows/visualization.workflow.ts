import type {Context} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {DbQueryAIExtensionBindings} from '../../components/db-query/keys';
import type {DataSetHelper} from '../../components/db-query/services';
import type {IDataSetStore} from '../../components/db-query/types';
import {VISUALIZATION_KEY} from '../../components/visualization/keys';
import type {IVisualizer} from '../../components/visualization/types';

/**
 * `visualizationWorkflow` — Mastra port of the 4-node VisualizationGraph.
 * Linear DAG with one branch: when `needsQuery` is true the workflow
 * runs the query-generation step before fetching dataset rows; otherwise
 * it pulls cached dataset rows directly. Either branch then dispatches
 * to the visualizer registry via renderVisualizationStep.
 *
 * See the migration plan. Restore strategy: lift v2
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
    userQuery: z.string(),
  }),
  execute: async ({inputData, mastra, requestContext}) => {
    if (inputData.datasetId) {
      return {
        datasetId: inputData.datasetId,
        needsQuery: false,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
      };
    }
    const generate = mastra?.getWorkflow?.('generateQueryWorkflow' as never);
    if (!generate) {
      return {
        datasetId: '',
        needsQuery: true,
        chartType: inputData.chartType,
        userQuery: inputData.userQuery,
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
      userQuery: inputData.userQuery,
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
    userQuery: z.string(),
    sql: z.string().optional(),
    description: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const wrapped = inputData as Record<string, unknown>;
    const fromCallQuery = wrapped['call-query-generation'] as
      | {datasetId?: string; chartType?: string; userQuery?: string}
      | undefined;
    const direct = wrapped as {
      datasetId?: string;
      chartType?: string;
      userQuery?: string;
    };
    const inferredId = fromCallQuery?.datasetId ?? direct.datasetId ?? '';
    const inferredChart = fromCallQuery?.chartType ?? direct.chartType ?? 'bar';
    const inferredQuery = fromCallQuery?.userQuery ?? direct.userQuery ?? '';
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    const baseline = {
      datasetId: inferredId,
      rows: [] as unknown[],
      chartType: inferredChart,
      userQuery: inferredQuery,
      sql: undefined as string | undefined,
      description: undefined as string | undefined,
    };
    if (!lb4Ctx) return baseline;
    const helper = await lb4Ctx.get<DataSetHelper>('services.DataSetHelper', {
      optional: true,
    });
    if (!helper) return baseline;
    // Fetch the dataset row to surface sql + description for the
    // visualizer.getConfig() call downstream — the built-in
    // visualizers (Pie/Bar/Line) reject empty prompt/sql/description
    // and would otherwise silently fall through to {chartConfig:{}}.
    let sql: string | undefined;
    let description: string | undefined;
    const datasetStore = await lb4Ctx.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
      {optional: true},
    );
    if (datasetStore && inferredId) {
      try {
        const ds = await datasetStore.findById(inferredId);
        sql = ds.query;
        description = ds.description;
      } catch {
        // not found / permission denied — leave undefined; render step
        // will surface the error to the user via its own try/catch.
      }
    }
    try {
      const rows = (await helper.getDataFromDataset(inferredId)) as unknown[];
      return {
        datasetId: inferredId,
        rows: rows ?? [],
        chartType: inferredChart,
        userQuery: inferredQuery,
        sql,
        description,
      };
    } catch {
      return {...baseline, sql, description};
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
      | {
          datasetId?: string;
          rows?: unknown[];
          chartType?: string;
          userQuery?: string;
          sql?: string;
          description?: string;
        }
      | undefined;
    const direct = wrapped as {
      datasetId?: string;
      rows?: unknown[];
      chartType?: string;
      userQuery?: string;
      sql?: string;
      description?: string;
    };
    const chartType = fromGetDataset?.chartType ?? direct.chartType ?? 'bar';
    const userQuery = fromGetDataset?.userQuery ?? direct.userQuery ?? '';
    const sql = fromGetDataset?.sql ?? direct.sql;
    const description = fromGetDataset?.description ?? direct.description;
    const datasetId = fromGetDataset?.datasetId ?? direct.datasetId ?? '';
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
        prompt: userQuery,
        datasetId,
        sql,
        queryDescription: description,
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

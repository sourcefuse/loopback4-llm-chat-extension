import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import type {DataSetHelper} from '../../components/db-query/services';
import type {IDataSetStore} from '../../components/db-query/types';
import type {IVisualizer} from '../../components/visualization/types';
import {
  getDataSetHelper,
  getDatasetStore,
  getVisualizers,
} from './db-query/_helpers';

const DEFAULT_CHART_TYPE = 'bar';

/**
 * Unwrap the branch-wrapped or direct upstream input. Mastra wraps the
 * matched branch's output under the branch step's id (mirroring the
 * .parallel() fan-in shape), so workflow steps that follow a branch
 * accept both shapes. Extracted to keep step bodies under SonarQube's
 * cyclomatic threshold.
 */
function pickFromBranch<T extends Record<string, unknown>>(
  inputData: unknown,
  branchKey: string,
): T {
  const wrapped = inputData as Record<string, unknown>;
  const fromBranch = wrapped[branchKey] as T | undefined;
  return (fromBranch ?? wrapped) as T;
}

async function fetchDatasetDescriptor(
  store: IDataSetStore | undefined,
  datasetId: string,
): Promise<{sql?: string; description?: string}> {
  if (!datasetId || !store) return {};
  try {
    const ds = await store.findById(datasetId);
    return {sql: ds.query, description: ds.description};
  } catch {
    return {};
  }
}

async function fetchDatasetRows(
  helper: DataSetHelper | undefined,
  datasetId: string,
): Promise<unknown[]> {
  if (!helper || !datasetId) return [];
  try {
    return ((await helper.getDataFromDataset(datasetId)) as unknown[]) ?? [];
  } catch {
    return [];
  }
}

function pickVisualizer(
  visualizers: IVisualizer[],
  chartType: string,
): IVisualizer | undefined {
  if (visualizers.length === 0) return undefined;
  return visualizers.find(v => v.name === chartType) ?? visualizers[0];
}

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
    let chartType = inputData.type ?? DEFAULT_CHART_TYPE;
    if (!inputData.type) {
      const visualizers = getVisualizers(requestContext);
      if (visualizers.length > 0) chartType = visualizers[0].name;
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
    const upstream = pickFromBranch<{
      datasetId?: string;
      chartType?: string;
      userQuery?: string;
    }>(inputData, 'call-query-generation');
    const datasetId = upstream.datasetId ?? '';
    const chartType = upstream.chartType ?? DEFAULT_CHART_TYPE;
    const userQuery = upstream.userQuery ?? '';
    const {sql, description} = await fetchDatasetDescriptor(
      getDatasetStore(requestContext),
      datasetId,
    );
    const rows = await fetchDatasetRows(
      getDataSetHelper(requestContext) as DataSetHelper | undefined,
      datasetId,
    );
    return {datasetId, rows, chartType, userQuery, sql, description};
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
    const upstream = pickFromBranch<{
      datasetId?: string;
      rows?: unknown[];
      chartType?: string;
      userQuery?: string;
      sql?: string;
      description?: string;
    }>(inputData, 'get-dataset-data');
    const chartType = upstream.chartType ?? DEFAULT_CHART_TYPE;
    const userQuery = upstream.userQuery ?? '';
    const sql = upstream.sql;
    const description = upstream.description;
    const datasetId = upstream.datasetId ?? '';
    const chosen = pickVisualizer(getVisualizers(requestContext), chartType);
    if (!chosen) return {chartConfig: {}};
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

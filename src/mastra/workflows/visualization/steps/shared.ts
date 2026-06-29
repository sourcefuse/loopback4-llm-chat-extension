import {z} from 'zod';
import type {DataSetHelper} from '../../../../components/db-query/services';
import type {IDataSetStore} from '../../../../components/db-query/types';
import {getDbQueryConfig, type MastraRc} from '../../db-query/_helpers';
import type {IVisualizer} from '../../../../components/visualization/types';

export const DEFAULT_CHART_TYPE = 'bar';
export const STEP_GET_DATASET_DATA = 'get-dataset-data';

export const visualizationInputSchema = z.object({
  datasetId: z.string(),
  userQuery: z.string(),
  type: z.string().optional(),
});

export const visualizationOutputSchema = z.object({
  visualization: z.string().optional(),
  chartConfig: z.unknown(),
  datasetId: z.string().optional(),
  sql: z.string().optional(),
  description: z.string().optional(),
  // Set when the LLM judged that NONE of the registered visualizers fit the
  // request (v2 select-visualization.node "none" path). The tool surfaces
  // this reason to the agent instead of emitting a forced chart.
  error: z.string().optional(),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function extractWorkflowResult(value: unknown): Record<string, unknown> {
  const root = asRecord(value);
  return asRecord(root.result);
}

export function pickFromBranch(
  inputData: unknown,
  branchKey: string,
): Record<string, unknown> {
  const wrapped = asRecord(inputData);
  const fromBranch = wrapped[branchKey];
  return isRecord(fromBranch) ? fromBranch : wrapped;
}

export async function fetchDatasetDescriptor(
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

export async function fetchDatasetRows(
  helper: DataSetHelper | undefined,
  datasetId: string,
  rc?: MastraRc,
): Promise<unknown[]> {
  if (!helper || !datasetId) return [];
  try {
    // Respect maxRowsForAI from DbQueryConfig — passing unbounded rows to the
    // visualizer/LLM path is expensive and unnecessary. Default cap mirrors
    // DataSetHelper.getDataFromDataset's own default (100) when unset.
    const limit = getDbQueryConfig(rc)?.maxRowsForAI ?? 100;
    const rows = await helper.getDataFromDataset(datasetId, limit);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function pickVisualizer(
  visualizers: IVisualizer[],
  chartType: string,
): IVisualizer | undefined {
  if (visualizers.length === 0) return undefined;
  return visualizers.find(v => v.name === chartType) ?? visualizers[0];
}

/**
 * Outcome of the LLM visualization-type selection. Either a concrete chart
 * type, or an explicit rejection carrying the reason no registered visualizer
 * fits the request (v2 select-visualization.node "none" path).
 */
export type VisualizerSelection =
  | {chartType: string}
  | {rejected: true; reason: string};

/**
 * Build the prompt that asks the LLM to pick the best-fitting visualizer for
 * the user's request — or to reject when none fit. Ports the v2
 * select-visualization.node prompt: each visualizer is listed with its
 * description + data requirements (`context`), and the model may answer
 * "none: <reason>" rather than force-fitting an unsuitable chart.
 */
export function buildVisualizerSelectionPrompt(
  userQuery: string,
  visualizers: IVisualizer[],
): string {
  const options = visualizers
    .map(
      v =>
        `- ${v.name}: ${v.description}${
          v.context ? ` (Data requirements: ${v.context})` : ''
        }`,
    )
    .join('\n');
  const example = visualizers[0]?.name ?? DEFAULT_CHART_TYPE;
  return `You are a data-visualization expert. Select the SINGLE best visualization for the user's request from the available options.

<available-visualizations>
${options}
</available-visualizations>

<user-request>
${userQuery}
</user-request>

<instructions>
Reply with ONLY the name of the best-fitting visualization (e.g. "${example}").
If none of the visualizations fit the requirement, reply with "none" followed by a colon and a short reason describing what the data would need for a visualization to be possible.
Do not force-fit the request to a visualization that does not make sense — prefer "none" with a clear reason instead.
</instructions>

<output-example-1>
${example}
</output-example-1>
<output-example-2>
none: the requested data is a single scalar value and cannot be charted.
</output-example-2>`;
}

/**
 * Parse the selection LLM's reply. A reply starting with "none" is an explicit
 * rejection (the remainder is the reason). Otherwise we match the reply against
 * a registered visualizer name; an unrecognised reply falls back to the first
 * visualizer rather than failing the run.
 */
export function parseVisualizerSelection(
  raw: string,
  visualizers: IVisualizer[],
): VisualizerSelection {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith('none')) {
    const reason = text
      .slice('none'.length)
      .replace(/^[\s:.\-–—]+/, '')
      .trim();
    return {
      rejected: true,
      reason: reason || 'No suitable visualization for the request.',
    };
  }
  const exact = visualizers.find(v => v.name.toLowerCase() === lower);
  if (exact) return {chartType: exact.name};
  const contained = visualizers.find(v => lower.includes(v.name.toLowerCase()));
  if (contained) return {chartType: contained.name};
  return {chartType: visualizers[0]?.name ?? DEFAULT_CHART_TYPE};
}

import {z} from 'zod';
import type {DataSetHelper} from '../db-query/services';
import type {IDataSetStore} from '../db-query/types';
import {getDbQueryConfig, type MastraRc} from '../db-query/_helpers';
import type {IVisualizer} from './types';

export const DEFAULT_CHART_TYPE = 'bar';

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
  {chartType: string} | {rejected: true; reason: string};

/**
 * The data shape the selector reasons about — the generated SQL, the dataset
 * description, and the column names of the first result row. v2's
 * select-visualization.node fed {sql, description} into the prompt so the model
 * matched the chart to the DATA (time-series → line, categories → bar,
 * proportions → pie) instead of guessing from the request wording alone.
 */
export interface VisualizationDataContext {
  sql?: string;
  description?: string;
  columns?: string[];
}

export function buildVisualizerSelectionPrompt(
  userQuery: string,
  visualizers: IVisualizer[],
  data: VisualizationDataContext = {},
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
  const hasData =
    Boolean(data.sql) ||
    Boolean(data.description) ||
    Boolean(data.columns?.length);
  const columnsText = data.columns?.length
    ? data.columns.join(', ')
    : '(unknown)';
  const dataBlock = hasData
    ? `
<data>
Match the chart to the column shape this query returns, not just the wording of the request.
SQL: ${data.sql ?? '(unavailable)'}
Description: ${data.description ?? '(none)'}
Columns: ${columnsText}
</data>
`
    : '';
  return `You are a data-visualization expert. Select the SINGLE best visualization for the user's request and the data it returns, from the available options.

<available-visualizations>
${options}
</available-visualizations>

<user-request>
${userQuery}
</user-request>
${dataBlock}
<instructions>
Reply with ONLY the name of the best-fitting visualization (e.g. "${example}") on its own — no explanation.
If none of the visualizations fit, reply with "none" followed by a colon and a short reason describing what the data would need for a visualization to be possible.
Do not force-fit the request to a visualization that does not make sense — prefer "none" with a clear reason instead.
</instructions>

<output-example-1>
${example}
</output-example-1>
<output-example-2>
none: the requested data is a single scalar value and cannot be charted.
</output-example-2>`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Whole-word match of a visualizer name in `lower`, returning the LAST-mentioned
 * one (the model's verdict). Extracted from parseVisualizerSelection to keep its
 * complexity under the limit (S1541).
 */
function lastMentionedVisualizer(
  lower: string,
  visualizers: IVisualizer[],
): string | undefined {
  let best: {name: string; idx: number} | undefined;
  for (const v of visualizers) {
    const re = new RegExp(
      String.raw`\b` + escapeRegExp(v.name.toLowerCase()) + String.raw`\b`,
      'g',
    );
    let lastIdx = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) lastIdx = m.index;
    if (lastIdx >= 0 && (!best || lastIdx > best.idx)) {
      best = {name: v.name, idx: lastIdx};
    }
  }
  return best?.name;
}

/**
 * Parse the selection LLM's reply. "none" → explicit rejection (remainder is the
 * reason). Otherwise: exact match first; then a WHOLE-WORD match preferring the
 * LAST-mentioned visualizer (so "not a bar chart, use line" picks `line`, and
 * short names like `line` don't match inside `timeline`). Unrecognised replies
 * fall back to the first visualizer rather than failing the run.
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
  const last = lastMentionedVisualizer(lower, visualizers);
  if (last) return {chartType: last};
  return {chartType: visualizers[0]?.name ?? DEFAULT_CHART_TYPE};
}

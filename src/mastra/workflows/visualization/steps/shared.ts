import {z} from 'zod';
import type {DataSetHelper} from '../../../../components/db-query/services';
import type {IDataSetStore} from '../../../../components/db-query/types';
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
): Promise<unknown[]> {
  if (!helper || !datasetId) return [];
  try {
    const rows = await helper.getDataFromDataset(datasetId);
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

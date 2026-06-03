import {Entity} from '@loopback/repository';
import {ModelConstructor} from '@sourceloop/core';
import {DEFAULT_MAX_READ_ROWS_FOR_AI} from './constant';
import {DbQueryConfig, IDataSetStore, IModelConfig} from './types';

export function isModelWithPermission(m: IModelConfig): m is {
  model: ModelConstructor<Entity>;
  readPermissionKey: string;
} {
  return (m as {readPermissionKey?: string}).readPermissionKey !== undefined;
}

export function getModelFromConfig(m: IModelConfig): ModelConstructor<Entity> {
  return isModelWithPermission(m) ? m.model : m;
}

/**
 * Build the message the dataset tools hand back to the AI agent.
 *
 * Mirrors the v2 GetDataAsDatasetTool.getValue contract: the AI is told
 * the dataset was produced and rendered for the user, and given the
 * dataset ID — nothing more. It deliberately does NOT expose a row count
 * or result rows by default, because the AI's job is to generate the
 * query, not to read the data (the UI renders the grid from the ID).
 *
 * Result rows are appended ONLY when the consumer opts in via
 * `config.readAccessForAI`, capped at `config.maxRowsForAI`
 * (default {@link DEFAULT_MAX_READ_ROWS_FOR_AI}). The read is advisory:
 * a failure here never fails the tool.
 */
export async function buildDatasetReadout(args: {
  datasetId: string;
  verb: 'generated' | 'updated';
  store?: IDataSetStore;
  config?: DbQueryConfig;
}): Promise<string> {
  const {datasetId, verb, store, config} = args;
  if (!datasetId) {
    return `Could not ${verb === 'generated' ? 'generate' : 'update'} the dataset for that request.`;
  }
  const base = `Dataset ${verb} and has been rendered for the user (dataset ID ${datasetId}). The task is COMPLETE. Do NOT call this or any other tool again for this request — reply to the user with ONE short sentence confirming it is done.`;
  if (!config?.readAccessForAI || !store) {
    return base;
  }
  try {
    const max = config.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI;
    const rows = await store.getData(datasetId, max);
    if (!rows?.length) {
      return base;
    }
    return `${base} First ${max} results from the dataset are: ${JSON.stringify(rows)}`;
  } catch {
    return base;
  }
}

import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  computeSchemaHash,
  getAuthUser,
  getDatasetStore,
  getSchemaHelper,
  getSchemaStore,
  idToString,
  resolvePersistDeps,
} from '../_helpers';
import {outputSchema} from './constants';

export const saveDatasetStep = createStep({
  id: 'save-dataset',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      sql?: string;
      description?: string;
      prompt?: string;
      tables?: string[];
      cached?: boolean;
      datasetId?: string;
    };

    if (data.cached && data.datasetId) {
      return {datasetId: idToString(data.datasetId), sql: data.sql ?? ''};
    }

    const fallback = {datasetId: '', sql: data.sql ?? ''};
    if (!data.sql) return fallback;

    const persist = resolvePersistDeps(
      getDatasetStore(requestContext),
      getAuthUser(requestContext),
    );
    if (!persist) return fallback;

    const {schemaHash, tablesFromSchema} = computeSchemaHash(
      getSchemaHelper(requestContext),
      getSchemaStore(requestContext),
    );
    const tableList = data.tables?.length ? data.tables : tablesFromSchema;

    const dataset = await persist.store.create({
      tenantId: persist.user.tenantId,
      query: data.sql,
      description: data.description ?? '',
      prompt: data.prompt ?? '',
      tables: tableList,
      schemaHash,
      votes: 0,
    });

    return {datasetId: idToString(dataset.id), sql: data.sql};
  },
});

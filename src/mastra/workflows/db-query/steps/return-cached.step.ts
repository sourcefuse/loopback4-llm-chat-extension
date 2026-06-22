import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {getDatasetStore, idToString} from '../_helpers';
import {branchCachedSchema} from './constants';

export const returnCachedStep = createStep({
  id: 'return-cached',
  inputSchema: z.any(),
  outputSchema: branchCachedSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {datasetId?: string};
    const fallback = {
      kind: 'cached' as const,
      datasetId: data.datasetId ?? '',
      sql: '',
    };
    const store = getDatasetStore(requestContext);
    if (!store || !data.datasetId) return fallback;

    try {
      const dataset = await store.findById(data.datasetId);
      return {
        kind: 'cached' as const,
        datasetId: idToString(dataset.id ?? data.datasetId),
        sql: dataset.query ?? '',
      };
    } catch {
      return fallback;
    }
  },
});

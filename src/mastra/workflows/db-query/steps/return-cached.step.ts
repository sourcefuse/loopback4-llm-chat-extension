import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {getDatasetStore, idToString} from '../_helpers';
import {outputSchema} from './constants';

export const returnCachedStep = createStep({
  id: 'return-cached',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {datasetId?: string};
    const fallback = {datasetId: data.datasetId ?? '', sql: ''};
    const store = getDatasetStore(requestContext);
    if (!store || !data.datasetId) return fallback;

    try {
      const dataset = await store.findById(data.datasetId);
      return {
        datasetId: idToString(dataset.id ?? data.datasetId),
        sql: dataset.query ?? '',
      };
    } catch {
      return fallback;
    }
  },
});

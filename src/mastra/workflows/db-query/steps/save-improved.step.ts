import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {getDatasetStore} from '../_helpers';
import {improveOutputSchema} from './improve.shared';

export const saveImprovedStep = createStep({
  id: 'save-improved',
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      datasetId?: string;
      sql?: string;
      description?: string;
    };

    const failResult = {datasetId: '', sql: ''};
    if (!data.datasetId || !data.sql) return failResult;

    const store = getDatasetStore(requestContext);
    if (!store) return failResult;

    const patch: {query: string; description?: string} = {query: data.sql};
    if (data.description !== undefined) patch.description = data.description;

    try {
      await store.updateById(data.datasetId, patch);
    } catch {
      return failResult;
    }

    return {datasetId: data.datasetId, sql: data.sql};
  },
});

import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {getDatasetStore} from '../_helpers';
import {improveInputSchema} from './improve.shared';

export const loadExistingStep = createStep({
  id: 'load-existing',
  inputSchema: improveInputSchema,
  outputSchema: z.object({
    datasetId: z.string(),
    prompt: z.string(),
    originalPrompt: z.string().optional(),
    originalSql: z.string().optional(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
    loadError: z.boolean().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const base = {
      datasetId: inputData.datasetId,
      prompt: inputData.prompt,
      originalPrompt: undefined as string | undefined,
      originalSql: undefined as string | undefined,
      tables: [] as string[],
      checklist: '',
      attempts: 0,
      loadError: false,
    };

    const store = getDatasetStore(requestContext);
    if (!store) return {...base, loadError: true};

    try {
      const dataset = await store.findById(inputData.datasetId);
      return {
        ...base,
        originalPrompt: dataset.prompt,
        originalSql: dataset.query,
        tables: dataset.tables ?? [],
        prompt: `${dataset.prompt}\n also consider following feedback given by user -\n ${inputData.prompt}\n`,
      };
    } catch {
      return {...base, loadError: true};
    }
  },
});

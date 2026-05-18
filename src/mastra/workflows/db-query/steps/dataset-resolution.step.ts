import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {asDbQueryContext} from '../db-query-request-context';

/**
 * DatasetResolutionStep — replaces IsImprovementNode.
 *
 * Checks if this is an improvement of an existing dataset.
 * If improving, loads the original SQL and merges prompts.
 */
export const datasetResolutionStep = createStep({
  id: 'dataset-resolution',
  inputSchema: z.object({
    prompt: z.string(),
    datasetId: z.string().optional(),
  }),
  outputSchema: z.object({
    prompt: z.string(),
    sampleSql: z.string().optional(),
    sampleSqlPrompt: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const ctx = asDbQueryContext(requestContext!);
    const datasetStore = ctx.get('datasetStore');
    const datasetId = inputData.datasetId;

    if (datasetId) {
      const dataset = await datasetStore.findById(datasetId);
      return {
        prompt: `${dataset.prompt}\n also consider following feedback given by user -\n ${inputData.prompt}\n`,
        sampleSql: dataset.query,
        sampleSqlPrompt: dataset.prompt,
      };
    }

    return {
      prompt: inputData.prompt,
      sampleSql: undefined,
      sampleSqlPrompt: undefined,
    };
  },
});

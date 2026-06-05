import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {outputSchema} from './constants';

export const failedStep = createStep({
  id: 'failed',
  inputSchema: z.any(),
  outputSchema,
  execute: async () => ({datasetId: '', sql: ''}),
});

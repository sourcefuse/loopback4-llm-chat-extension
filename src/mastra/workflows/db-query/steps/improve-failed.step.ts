import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {improveOutputSchema} from './improve.shared';

export const improveFailedStep = createStep({
  id: 'failed',
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
  execute: async () => ({datasetId: '', sql: ''}),
});

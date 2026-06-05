import {z} from 'zod';

export const MAX_IMPROVE_ATTEMPTS = 3;

export const improveInputSchema = z.object({
  datasetId: z.string(),
  prompt: z.string(),
});

export const improveOutputSchema = z.object({
  datasetId: z.string(),
  sql: z.string(),
});

export function loadErrorShortCircuit(data: {
  datasetId?: string;
  prompt?: string;
  tables?: string[];
  checklist?: string;
  attempts?: number;
}) {
  return {
    datasetId: data.datasetId ?? '',
    sql: '',
    passed: false,
    attempts: (data.attempts ?? 0) + 1,
    feedback: 'Unable to load source dataset for improvement',
    description: undefined,
    prompt: data.prompt ?? '',
    tables: data.tables ?? [],
    checklist: data.checklist ?? '',
  };
}

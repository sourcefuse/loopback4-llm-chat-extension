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
  // Force attempts to the cap so the dountil loop exits immediately.
  // Incrementing by 1 wastes the remaining iterations — each re-enters
  // fixQueryStep which calls loadErrorShortCircuit again, doing nothing
  // useful until the counter eventually reaches MAX_IMPROVE_ATTEMPTS.
  return {
    datasetId: data.datasetId ?? '',
    sql: '',
    passed: false,
    attempts: MAX_IMPROVE_ATTEMPTS,
    feedback: 'Unable to load source dataset for improvement',
    description: undefined,
    prompt: data.prompt ?? '',
    tables: data.tables ?? [],
    checklist: data.checklist ?? '',
  };
}

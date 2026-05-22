import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';

/**
 * `improveQueryWorkflow` — improvement variant of `generateQueryWorkflow`.
 * Enters with an existing datasetId and a delta prompt, skips the
 * cache/templates fan-out, and dives straight into the validate-retry
 * loop. See MIGRATION-STRATEGY.md Section 9.2.
 *
 * P3 scope: skeleton only. Step bodies are stubs that pass through
 * the inputData; real logic moves in alongside the legacy
 * DbQueryService helpers (Section 16A.4).
 */

const inputSchema = z.object({
  datasetId: z.string(),
  prompt: z.string(),
});

const outputSchema = z.object({
  datasetId: z.string(),
  sql: z.string(),
  rowCount: z.number(),
});

const loadExistingStep = createStep({
  id: 'load-existing',
  inputSchema,
  outputSchema: z.object({
    datasetId: z.string(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
  }),
  execute: async ({inputData}) => ({
    datasetId: inputData.datasetId,
    prompt: inputData.prompt,
    tables: [],
    checklist: '',
    attempts: 0,
  }),
});

const fixQueryStep = createStep({
  id: 'fix-query',
  inputSchema: z.object({
    datasetId: z.string(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
    feedback: z.string().optional(),
    attempts: z.number(),
  }),
  outputSchema: z.object({
    datasetId: z.string(),
    sql: z.string(),
    passed: z.boolean(),
    attempts: z.number(),
    feedback: z.string().optional(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
  }),
  execute: async ({inputData}) => ({
    datasetId: inputData.datasetId,
    sql: '',
    passed: true,
    attempts: inputData.attempts + 1,
    feedback: undefined,
    prompt: inputData.prompt,
    tables: inputData.tables,
    checklist: inputData.checklist,
  }),
});

const saveImprovedStep = createStep({
  id: 'save-improved',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData}) => ({
    datasetId: (inputData as {datasetId?: string})?.datasetId ?? '',
    sql: (inputData as {sql?: string})?.sql ?? '',
    rowCount: 0,
  }),
});

const failedStep = createStep({
  id: 'failed',
  inputSchema: z.any(),
  outputSchema,
  execute: async () => ({datasetId: '', sql: '', rowCount: 0}),
});

export const improveQueryWorkflow = createWorkflow({
  id: 'improve-query',
  inputSchema,
  outputSchema,
})
  .then(loadExistingStep)
  .dountil(
    fixQueryStep,
    async ({inputData}) => inputData.passed || inputData.attempts >= 3,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedStep,
    ],
    [async () => true, saveImprovedStep],
  ])
  .commit();

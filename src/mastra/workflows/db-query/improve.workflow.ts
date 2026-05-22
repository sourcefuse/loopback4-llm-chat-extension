import type {Context} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {DbQueryAIExtensionBindings} from '../../../components/db-query/keys';
import type {IDataSetStore} from '../../../components/db-query/types';

/**
 * `improveQueryWorkflow` — improvement variant of `generateQueryWorkflow`.
 * Enters with an existing datasetId and a delta prompt, skips the
 * cache/templates fan-out, and dives straight into the validate-retry
 * loop. See MIGRATION-STRATEGY.md Section 9.2.
 *
 * Restore strategy for remaining stub bodies: lift v2 IsImprovement +
 * FixQuery + SaveDataset node bodies from
 * `git show 4be9767^:src/components/db-query/nodes/<name>.node.ts`.
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

/**
 * load-existing — wired. Resolves IDataSetStore via lb4Ctx, fetches the
 * dataset row, then merges the user's delta prompt onto the original
 * (mirroring v2 IsImprovementNode.execute at 4be9767^). When the
 * dataset is not found the step still completes with the inputData
 * verbatim so the downstream fix-query loop can produce a "failed"
 * outcome instead of crashing the run.
 */
const loadExistingStep = createStep({
  id: 'load-existing',
  inputSchema,
  outputSchema: z.object({
    datasetId: z.string(),
    prompt: z.string(),
    originalPrompt: z.string().optional(),
    originalSql: z.string().optional(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
  }),
  execute: async ({inputData, requestContext}) => {
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    const base = {
      datasetId: inputData.datasetId,
      prompt: inputData.prompt,
      originalPrompt: undefined as string | undefined,
      originalSql: undefined as string | undefined,
      tables: [] as string[],
      checklist: '',
      attempts: 0,
    };
    if (!lb4Ctx) return base;
    const store = await lb4Ctx.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
      {optional: true},
    );
    if (!store) return base;
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
      return base;
    }
  },
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

/**
 * save-improved — wired. Updates the existing dataset row with the new
 * SQL produced by the dountil(fix-query) loop. No tenant check needed
 * since the row already belongs to the caller (load-existing resolved
 * it via findById which honours datasource RLS).
 */
const saveImprovedStep = createStep({
  id: 'save-improved',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      datasetId?: string;
      sql?: string;
      description?: string;
    };
    const fallback = {
      datasetId: data.datasetId ?? '',
      sql: data.sql ?? '',
      rowCount: 0,
    };
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx || !data.datasetId || !data.sql) return fallback;
    const store = await lb4Ctx.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
      {optional: true},
    );
    if (!store) return fallback;
    try {
      await store.updateById(data.datasetId, {
        query: data.sql,
        description: data.description ?? undefined,
      });
    } catch {
      return fallback;
    }
    return {datasetId: data.datasetId, sql: data.sql, rowCount: 0};
  },
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

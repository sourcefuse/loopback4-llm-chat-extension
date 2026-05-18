import {createWorkflow, createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  dbQueryWorkflowInputSchema,
  dbQueryWorkflowOutputSchema,
  DatabaseSchemaZ,
} from './db-query-workflow-schemas';
import type {DbQueryWorkflowInput} from './db-query-workflow-schemas';
import {datasetResolutionStep} from './steps/dataset-resolution.step';
import {discoveryWorkflow} from './workflows/discovery.workflow';
import {fullGenerationWorkflow} from './workflows/full-generation.workflow';
import {failureStep} from './steps/failure.step';
import {datasetPersistenceStep} from './steps/dataset-persistence.step';
import type {BranchContext} from './contracts/branch.contract';
import type {DiscoveryRoutingOut} from './contracts/step-outputs.contract';

/**
 * DBQueryWorkflow — Mastra replacement for the LangGraph DbQueryGraph.
 *
 * Implements the complete DB query generation pipeline using Mastra-native
 * workflow composition:
 *
 *  1. `workflowInitStep`:
 *     Resolves the existing dataset (if improving) and carries the DB schema
 *     and directCall flag forward — fields that datasetResolutionStep does
 *     not pass through.
 *
 *  2. `discoveryWorkflow` (sub-workflow):
 *     Runs cache-check, table-selection, template-match, and change-
 *     classification in PARALLEL, merges the results, and determines route.
 *
 *  3. `.branch()` on discovery route:
 *     - `from-cache`    → fromCacheDoneStep (return cached result)
 *     - `from-template` → templatePersistenceStep (save template SQL)
 *     - `failed`        → failureStep (emit error)
 *     - `continue`      → fullGenerationWorkflow (column-select + SQL gen loop)
 *
 *  `fullGenerationWorkflow` (sub-workflow):
 *     - Runs column selection + checklist generation
 *     - Loops SQL generation + validation with `.dountil()` (max 4 iterations)
 *     - Branches on loop result: accepted → save dataset, failed → emit error
 *
 * All LLM calls use Agent.generate() via the individual step implementations.
 * All events are streamed via the Mastra writer (workflow-native streaming).
 */

/** Returns the cached result directly (no SQL generation needed). */
const fromCacheDoneStep = createStep({
  id: 'from-cache-done',
  inputSchema: z.object({
    route: z.string(),
    datasetId: z.string().optional(),
    replyToUser: z.string().optional(),
  }),
  outputSchema: dbQueryWorkflowOutputSchema,
  execute: async ({inputData}) => ({
    datasetId: inputData.datasetId,
    replyToUser: inputData.replyToUser,
    fromCache: true,
    done: true,
  }),
});

const templatePersistenceInputSchema = z.object({
  route: z.string(),
  prompt: z.string(),
  sql: z.string().optional(),
  schema: DatabaseSchemaZ.optional(),
  description: z.string().optional(),
  directCall: z.boolean().optional(),
});

type TemplatePersistenceInput = z.infer<typeof templatePersistenceInputSchema>;

const datasetResolutionOutputSchema = z.object({
  prompt: z.string(),
  sampleSql: z.string().optional(),
  sampleSqlPrompt: z.string().optional(),
});

const datasetPersistenceOutputSchema = z.object({
  datasetId: z.string().optional(),
  replyToUser: z.string().optional(),
  done: z.boolean().optional(),
  resultArray: z.array(z.object({}).passthrough()).optional(),
});

/** Saves template-matched SQL as a dataset using native workflow chaining. */
const templatePersistenceWorkflow = createWorkflow({
  id: 'template-persistence-branch',
  inputSchema: templatePersistenceInputSchema,
  outputSchema: dbQueryWorkflowOutputSchema,
})
  .map(async ({inputData}) => {
    const data = templatePersistenceInputSchema.parse(inputData);
    return {
      prompt: data.prompt,
      sql: data.sql ?? '',
      schema: data.schema,
      description: data.description,
      directCall: data.directCall,
    };
  })
  .then(datasetPersistenceStep)
  .map(async ({inputData, getInitData}) => {
    const data = datasetPersistenceOutputSchema.parse(inputData);
    const initData = getInitData<TemplatePersistenceInput>();
    return {
      datasetId: data.datasetId,
      sql: initData.sql,
      description: initData.description ?? data.replyToUser,
      replyToUser: data.replyToUser,
      resultArray: data.resultArray,
      done: true,
    };
  })
  .commit();

// ── Branch context types ───────────────────────────────────────────────────────
type DiscoveryCtx = BranchContext<DiscoveryRoutingOut>;

// ── Main workflow ─────────────────────────────────────────────────────────────

export const dbQueryWorkflow = createWorkflow({
  id: 'db-query-workflow',
  inputSchema: dbQueryWorkflowInputSchema,
  outputSchema: dbQueryWorkflowOutputSchema,
})
  // 1. Resolve existing dataset prompt context
  .then(datasetResolutionStep)

  // 2. Carry required workflow input fields forward via native map
  .map(async ({inputData, getInitData}) => {
    const data = datasetResolutionOutputSchema.parse(inputData);
    const initData = getInitData<DbQueryWorkflowInput>();
    return {
      prompt: data.prompt,
      schema: initData.schema,
      sampleSql: data.sampleSql,
      sampleSqlPrompt: data.sampleSqlPrompt,
      directCall: initData.directCall,
      datasetId: initData.datasetId,
    };
  })

  // 3. Parallel discovery → routing decision
  .then(discoveryWorkflow)

  // 4. Route to terminal or generation paths
  .branch([
    [
      async (ctx: DiscoveryCtx) => ctx.inputData?.route === 'from-cache',
      fromCacheDoneStep,
    ],
    [
      async (ctx: DiscoveryCtx) => ctx.inputData?.route === 'from-template',
      templatePersistenceWorkflow,
    ],
    [
      async (ctx: DiscoveryCtx) => ctx.inputData?.route === 'failed',
      failureStep,
    ],
    [
      async (ctx: DiscoveryCtx) => ctx.inputData?.route === 'continue',
      fullGenerationWorkflow,
    ],
  ])
  .commit();

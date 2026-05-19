import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  dbQueryWorkflowOutputSchema,
  DatabaseSchemaZ,
} from '../db-query-workflow-schemas';
import {
  columnSelectionStep,
  generateChecklistStep,
  verifyChecklistStep,
  validationCycleStep,
  validationCycleSchema,
  datasetPersistenceStep,
  failureStep,
} from '../steps';
import type {BranchContext} from '../contracts/branch.contract';
import type {ValidationCycleState} from '../steps';

/**
 * FullGenerationWorkflow — runs the complete SQL generation pipeline.
 *
 * Receives the routing decision from the discovery phase and executes:
 *  1. Column selection + checklist generation (pre-generation)
 *     → Branches to failure if column selection fails
 *  2. SQL generation + validation loop (dountil up to MAX_CYCLE_ITERATIONS)
 *     → Loops until accepted, failed, or max iterations reached
 *  3. Branches on final route:
 *     → accepted: save dataset and return result
 *     → failed/max: emit failure message
 */

/** Maximum validation+repair iterations before giving up. */
const MAX_CYCLE_ITERATIONS = 4;

/** Input is the discoveryRoutingStep output for the 'continue' route. */
const fullGenerationInputSchema = z.object({
  prompt: z.string(),
  schema: DatabaseSchemaZ,
  changeType: z.enum(['minor', 'major', 'rewrite']).optional(),
  sampleSql: z.string().optional(),
  sampleSqlPrompt: z.string().optional(),
  fromCache: z.boolean().optional(),
  directCall: z.boolean().optional(),
  datasetId: z.string().optional(),
  route: z.string().optional(),
});

type FullGenerationInput = z.infer<typeof fullGenerationInputSchema>;

const postColumnSelectionSchema = z.object({
  prompt: z.string(),
  schema: DatabaseSchemaZ,
  changeType: z.enum(['minor', 'major', 'rewrite']).optional(),
  sampleSql: z.string().optional(),
  sampleSqlPrompt: z.string().optional(),
  fromCache: z.boolean().optional(),
  directCall: z.boolean().optional(),
  feedbacks: z.array(z.string()).optional(),
  fixAttempts: z.number(),
  status: z.string().optional(),
  replyToUser: z.string().optional(),
});

type PostColumnSelectionState = z.infer<typeof postColumnSelectionSchema>;

const failureOutputSchema = z.object({
  replyToUser: z.string(),
});

const datasetPersistenceOutputSchema = z.object({
  datasetId: z.string().optional(),
  replyToUser: z.string().optional(),
  done: z.boolean().optional(),
  resultArray: z.array(z.object({}).passthrough()).optional(),
});

const columnSelectionOutputSchema = z.object({
  schema: DatabaseSchemaZ,
  status: z.string().optional(),
  replyToUser: z.string().optional(),
});

type CycleCtx = BranchContext<ValidationCycleState>;

/** Condition for the dountil loop: stop when a terminal route is reached or cap exceeded. */
const isTerminalRoute = async (ctx: CycleCtx): Promise<boolean> => {
  const route = ctx.inputData?.route;
  return (
    route === 'accepted' ||
    route === 'failed' ||
    (ctx.iterationCount ?? 0) >= MAX_CYCLE_ITERATIONS
  );
};

/** Type alias for column-and-checklist output used in branch conditions. */
type ColCheckCtx = BranchContext<PostColumnSelectionState>;

const fullGenerationFailureWorkflow = createWorkflow({
  id: 'full-generation-failure',
  inputSchema: postColumnSelectionSchema,
  outputSchema: dbQueryWorkflowOutputSchema,
})
  .map(async ({inputData}) => {
    const data = postColumnSelectionSchema.parse(inputData);
    return {
      replyToUser: data.replyToUser,
      feedbacks: data.feedbacks,
    };
  })
  .then(failureStep)
  .map(async ({inputData}) => {
    const data = failureOutputSchema.parse(inputData);
    return {
      replyToUser: data.replyToUser,
      done: true,
    };
  })
  .commit();

const acceptedPersistenceWorkflow = createWorkflow({
  id: 'accepted-persistence',
  inputSchema: validationCycleSchema,
  outputSchema: dbQueryWorkflowOutputSchema,
})
  .map(async ({inputData}) => {
    const data = validationCycleSchema.parse(inputData);
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
    const initData = getInitData<ValidationCycleState>();
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

const fullGenerationContinueWorkflow = createWorkflow({
  id: 'full-generation-continue',
  inputSchema: postColumnSelectionSchema,
  outputSchema: dbQueryWorkflowOutputSchema,
})
  .parallel([generateChecklistStep, verifyChecklistStep])
  .map(async ({inputData, getInitData}) => {
    const initData = getInitData<PostColumnSelectionState>();
    return {
      prompt: initData.prompt,
      schema: initData.schema,
      changeType: initData.changeType,
      sampleSql: initData.sampleSql,
      sampleSqlPrompt: initData.sampleSqlPrompt,
      fromCache: initData.fromCache,
      validationChecklist:
        inputData['verify-checklist'].validationChecklist ??
        inputData['generate-checklist'].validationChecklist,
      feedbacks: initData.feedbacks,
      directCall: initData.directCall,
      fixAttempts: initData.fixAttempts,
    };
  })
  .dountil(validationCycleStep, isTerminalRoute)
  .branch([
    [
      async (ctx: CycleCtx) => ctx.inputData?.route === 'accepted',
      acceptedPersistenceWorkflow,
    ],
    [
      async (ctx: CycleCtx) => ctx.inputData?.route !== 'accepted',
      fullGenerationFailureWorkflow,
    ],
  ])
  .commit();

export const fullGenerationWorkflow = createWorkflow({
  id: 'full-generation',
  inputSchema: fullGenerationInputSchema,
  outputSchema: dbQueryWorkflowOutputSchema,
})
  // Step 1: column selection
  .then(columnSelectionStep)

  // Step 2: re-attach carried fields from workflow input for downstream steps
  .map(async ({inputData, getInitData}) => {
    const data = columnSelectionOutputSchema.parse(inputData);
    const initData = getInitData<FullGenerationInput>();
    return {
      prompt: initData.prompt,
      schema: data.schema,
      changeType: initData.changeType,
      sampleSql: initData.sampleSql,
      sampleSqlPrompt: initData.sampleSqlPrompt,
      fromCache: initData.fromCache,
      directCall: initData.directCall,
      feedbacks: undefined,
      fixAttempts: 0,
      status: data.status,
      replyToUser: data.replyToUser,
    };
  })

  // Step 3: branch on column selection failure
  .branch([
    [
      async (ctx: ColCheckCtx) => ctx.inputData?.status === 'failed',
      fullGenerationFailureWorkflow,
    ],
    [
      async (ctx: ColCheckCtx) => ctx.inputData?.status !== 'failed',
      fullGenerationContinueWorkflow,
    ],
  ])
  .commit();

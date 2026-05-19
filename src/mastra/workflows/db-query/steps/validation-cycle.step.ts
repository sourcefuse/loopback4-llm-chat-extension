import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {DatabaseSchemaZ} from '../db-query-workflow-schemas';
import {tableSelectionStep} from './table-selection.step';
import {sqlGenerationStep} from './sql-generation.step';
import {queryRepairStep} from './query-repair.step';
import {syntacticValidationStep} from './syntactic-validation.step';
import {semanticValidationStep} from './semantic-validation.step';
import {descriptionGenerationStep} from './description-generation.step';
import {validationMergeStep} from './validation-merge.step';

/** Shared schema for both input and output of the validation cycle (enables dountil loop). */
export const validationCycleSchema = z.object({
  prompt: z.string(),
  schema: DatabaseSchemaZ,
  sql: z.string().optional(),
  description: z.string().optional(),
  changeType: z.enum(['minor', 'major', 'rewrite']).optional(),
  sampleSql: z.string().optional(),
  sampleSqlPrompt: z.string().optional(),
  fromCache: z.boolean().optional(),
  validationChecklist: z.string().optional(),
  feedbacks: z.array(z.string()).optional(),
  syntacticErrorTables: z.array(z.string()).optional(),
  semanticErrorTables: z.array(z.string()).optional(),
  directCall: z.boolean().optional(),
  fixAttempts: z.number().default(0),
  route: z
    .enum(['accepted', 'fix-query', 'reselect-tables', 'failed'])
    .optional(),
  status: z.string().optional(),
  replyToUser: z.string().optional(),
});

export type ValidationCycleState = z.infer<typeof validationCycleSchema>;

function asValidationCycleState(inputData: unknown): ValidationCycleState {
  return validationCycleSchema.parse(inputData);
}

const tableSelectionOutputSchema = z.object({
  schema: DatabaseSchemaZ.optional(),
  status: z.string().optional(),
  replyToUser: z.string().optional(),
});

const sqlPreparationOutputSchema = z.object({
  sql: z.string().optional(),
  status: z.string().optional(),
  replyToUser: z.string().optional(),
});

const validationParallelOutputSchema = z.object({
  'syntactic-validation': z.object({
    syntacticStatus: z.string(),
    syntacticFeedback: z.string().optional(),
    syntacticErrorTables: z.array(z.string()).optional(),
  }),
  'semantic-validation': z.object({
    semanticStatus: z.string(),
    semanticFeedback: z.string().optional(),
    semanticErrorTables: z.array(z.string()).optional(),
  }),
  'description-generation': z.object({
    description: z.string().optional(),
  }),
});

const validationMergeInputSchema = z.object({
  syntacticStatus: z.string().optional(),
  syntacticFeedback: z.string().optional(),
  syntacticErrorTables: z.array(z.string()).optional(),
  semanticStatus: z.string().optional(),
  semanticFeedback: z.string().optional(),
  semanticErrorTables: z.array(z.string()).optional(),
  description: z.string().optional(),
  feedbacks: z.array(z.string()).optional(),
  sql: z.string().optional(),
  prompt: z.string(),
  schema: DatabaseSchemaZ,
  validationChecklist: z.string().optional(),
  directCall: z.boolean().optional(),
});

const validationMergeOutputSchema = z.object({
  route: z.enum(['accepted', 'fix-query', 'reselect-tables', 'failed']),
  status: z.string(),
  feedbacks: z.array(z.string()),
  syntacticErrorTables: z.array(z.string()).optional(),
  semanticErrorTables: z.array(z.string()).optional(),
  description: z.string().optional(),
  sql: z.string().optional(),
  prompt: z.string(),
  schema: DatabaseSchemaZ,
  validationChecklist: z.string().optional(),
  directCall: z.boolean().optional(),
});

const validationCyclePassthroughWorkflow = createWorkflow({
  id: 'validation-cycle-passthrough',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
})
  .map(async ({inputData}) => validationCycleSchema.parse(inputData))
  .commit();

const reselectTablesWorkflow = createWorkflow({
  id: 'validation-cycle-reselect-tables',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
})
  .map(async ({inputData}) => {
    const data = validationCycleSchema.parse(inputData);
    return {
      prompt: data.prompt,
      feedbacks: data.feedbacks,
      schema: data.schema,
    };
  })
  .then(tableSelectionStep)
  .map(async ({inputData, getInitData}) => {
    const initData = getInitData<ValidationCycleState>();
    const selection = tableSelectionOutputSchema.parse(inputData);

    if (selection.status === 'failed') {
      return buildFailedCycleState(initData, {
        replyToUser: selection.replyToUser,
      });
    }

    return {
      ...initData,
      schema: selection.schema ?? initData.schema,
      route: undefined,
      status: undefined,
      replyToUser: undefined,
    };
  })
  .commit();

const generateSqlWorkflow = createWorkflow({
  id: 'validation-cycle-generate-sql',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
})
  .map(async ({inputData}) => {
    const data = validationCycleSchema.parse(inputData);
    return {
      prompt: data.prompt,
      schema: data.schema,
      changeType: data.changeType,
      sampleSql: data.sampleSql,
      sampleSqlPrompt: data.sampleSqlPrompt,
      fromCache: data.fromCache,
      validationChecklist: data.validationChecklist,
      feedbacks: data.feedbacks,
      sql: data.sql,
    };
  })
  .then(sqlGenerationStep)
  .map(async ({inputData, getInitData}) => {
    const initData = getInitData<ValidationCycleState>();
    const generated = sqlPreparationOutputSchema.parse(inputData);

    if (generated.status === 'failed') {
      return buildFailedCycleState(initData, {
        sql: undefined,
        replyToUser: generated.replyToUser,
      });
    }

    return {
      ...initData,
      sql: generated.sql,
      route: undefined,
      status: undefined,
      replyToUser: undefined,
    };
  })
  .commit();

const repairSqlWorkflow = createWorkflow({
  id: 'validation-cycle-repair-sql',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
})
  .map(async ({inputData}) => {
    const data = validationCycleSchema.parse(inputData);
    return {
      prompt: data.prompt,
      sql: data.sql ?? '',
      schema: data.schema,
      feedbacks: data.feedbacks,
      syntacticErrorTables: data.syntacticErrorTables,
      semanticErrorTables: data.semanticErrorTables,
      validationChecklist: data.validationChecklist,
    };
  })
  .then(queryRepairStep)
  .map(async ({inputData, getInitData}) => {
    const initData = getInitData<ValidationCycleState>();
    const repaired = sqlPreparationOutputSchema.parse(inputData);

    if (repaired.status === 'failed') {
      return buildFailedCycleState(initData, {
        sql: initData.sql,
      });
    }

    return {
      ...initData,
      sql: repaired.sql ?? initData.sql,
      route: undefined,
      status: undefined,
      replyToUser: undefined,
    };
  })
  .commit();

const prepareSqlWorkflow = createWorkflow({
  id: 'validation-cycle-prepare-sql',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
})
  .branch([
    [
      async ({inputData}) => {
        const state = asValidationCycleState(inputData);
        return state.fixAttempts > 0 && !!state.sql;
      },
      repairSqlWorkflow,
    ],
    [async () => true, generateSqlWorkflow],
  ])
  .commit();

const runValidationWorkflow = createWorkflow({
  id: 'validation-cycle-run-validation',
  inputSchema: validationCycleSchema,
  outputSchema: validationMergeInputSchema,
})
  .parallel([
    syntacticValidationStep,
    semanticValidationStep,
    descriptionGenerationStep,
  ])
  .map(async ({inputData, getInitData}) => {
    const state = getInitData<ValidationCycleState>();
    const results = validationParallelOutputSchema.parse(inputData);

    return {
      syntacticStatus: results['syntactic-validation'].syntacticStatus,
      syntacticFeedback: results['syntactic-validation'].syntacticFeedback,
      syntacticErrorTables:
        results['syntactic-validation'].syntacticErrorTables,
      semanticStatus: results['semantic-validation'].semanticStatus,
      semanticFeedback: results['semantic-validation'].semanticFeedback,
      semanticErrorTables: results['semantic-validation'].semanticErrorTables,
      description: results['description-generation'].description,
      feedbacks: state.feedbacks,
      sql: state.sql,
      prompt: state.prompt,
      schema: state.schema,
      validationChecklist: state.validationChecklist,
      directCall: state.directCall,
    };
  })
  .commit();

const validationMergeWorkflow = createWorkflow({
  id: 'validation-cycle-merge',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
})
  .then(runValidationWorkflow)
  .then(validationMergeStep)
  .map(async ({inputData, getInitData}) => {
    const merged = validationMergeOutputSchema.parse(inputData);
    const initData = getInitData<ValidationCycleState>();

    return {
      ...merged,
      changeType: initData.changeType,
      sampleSql: initData.sampleSql,
      sampleSqlPrompt: initData.sampleSqlPrompt,
      fromCache: initData.fromCache,
      fixAttempts: initData.fixAttempts + 1,
    };
  })
  .commit();

const isFailedState = async ({
  inputData,
}: {
  inputData: unknown;
}): Promise<boolean> => {
  const parsed = validationCycleSchema.safeParse(inputData);
  return (
    parsed.success &&
    (parsed.data.route === 'failed' || parsed.data.status === 'failed')
  );
};

/**
 * ValidationCycleWorkflow — one complete iteration of the SQL validation loop.
 *
 * Each call performs:
 *  - (if `route === 'reselect-tables'`) Re-runs table selection with feedbacks
 *  - (if `fixAttempts > 0`) Repairs the SQL using validation feedbacks
 *  - (else) Generates new SQL from scratch
 *  - Runs syntactic validation, semantic validation, and description generation in parallel
 *  - Merges validation results to produce the next iteration route decision
 */
export const validationCycleWorkflow = createWorkflow({
  id: 'validation-cycle',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
})
  .branch([
    [
      async ({inputData}) => {
        const state = asValidationCycleState(inputData);
        return state.route === 'reselect-tables';
      },
      reselectTablesWorkflow,
    ],
    [async () => true, validationCyclePassthroughWorkflow],
  ])
  .branch([
    [isFailedState, validationCyclePassthroughWorkflow],
    [async () => true, prepareSqlWorkflow],
  ])
  .branch([
    [isFailedState, validationCyclePassthroughWorkflow],
    [async () => true, validationMergeWorkflow],
  ])
  .commit();

/**
 * Step wrapper for dountil(): delegates execution to the workflow-composed
 * validation cycle while preserving outer workflow writer propagation.
 */
export const validationCycleStep = createStep({
  id: 'validation-cycle-step',
  inputSchema: validationCycleSchema,
  outputSchema: validationCycleSchema,
  execute: async ({inputData, requestContext, writer}) => {
    const run = await validationCycleWorkflow.createRun();
    const result = await run.start({
      inputData,
      requestContext,
      outputWriter: async (output: unknown) => {
        await writer.write(output);
      },
    });

    if (result.status !== 'success') {
      throw new Error(
        'Validation cycle workflow did not complete successfully.',
      );
    }

    return validationCycleSchema.parse(result.result);
  },
});

function buildFailedCycleState(
  inputData: ValidationCycleState,
  overrides: Partial<ValidationCycleState>,
): ValidationCycleState {
  return {
    ...inputData,
    ...overrides,
    schema: resolveOverride(inputData, overrides, 'schema') ?? inputData.schema,
    sql: resolveOverride(inputData, overrides, 'sql'),
    replyToUser: resolveOverride(inputData, overrides, 'replyToUser'),
    route: 'failed',
    status: 'failed',
    feedbacks: inputData.feedbacks ?? [],
    fixAttempts: inputData.fixAttempts + 1,
  };
}

function resolveOverride<T extends keyof ValidationCycleState>(
  inputData: ValidationCycleState,
  overrides: Partial<ValidationCycleState>,
  key: T,
): ValidationCycleState[T] {
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? (overrides[key] as ValidationCycleState[T])
    : inputData[key];
}

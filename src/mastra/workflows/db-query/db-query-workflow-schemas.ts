import {z} from 'zod';

const looseObjectSchema = z.object({}).passthrough();

// ─── Enums as Zod literals ─────────────────────────────────────────────────

export const EvaluationResultSchema = z.enum([
  'pass',
  'query_error',
  'table_not_found',
]);

export const GenerationErrorSchema = z.literal('failed');

export const ChangeTypeSchema = z.enum(['minor', 'major', 'rewrite']);

export const CacheResultSchema = z.enum(['as-is', 'similar', 'not-relevant']);

export const StatusSchema = z.union([
  EvaluationResultSchema,
  GenerationErrorSchema,
  z.literal('permission_error'),
  z.literal('accept'),
  z.literal('query_issue'),
  z.literal('other_issue'),
]);

// ─── Database schema Zod types (validation only at workflow boundary) ───────

export const ColumnSchemaZ = z.object({
  type: z.string(),
  required: z.boolean(),
  description: z.string().optional(),
  id: z.boolean(),
  metadata: z.record(z.string(), looseObjectSchema).optional(),
});

export const TableSchemaZ = z.object({
  columns: z.record(ColumnSchemaZ),
  primaryKey: z.array(z.string()),
  description: z.string(),
  context: z.array(z.union([z.string(), z.record(z.string())])),
  hash: z.string(),
});

export const ForeignKeyZ = z.object({
  table: z.string(),
  column: z.string(),
  referencedTable: z.string(),
  referencedColumn: z.string(),
  type: z.string(),
  description: z.string().optional(),
});

export const DatabaseSchemaZ = z.object({
  tables: z.record(TableSchemaZ),
  relations: z.array(ForeignKeyZ),
});

// ─── Workflow Input Schema ──────────────────────────────────────────────────

export const dbQueryWorkflowInputSchema = z.object({
  prompt: z.string().describe('User natural language query'),
  schema: DatabaseSchemaZ.describe('Available database schema'),
  datasetId: z.string().optional().describe('Existing dataset ID if improving'),
  directCall: z
    .boolean()
    .optional()
    .describe('True when invoked internally (not from chat tool)'),
});

export type DbQueryWorkflowInput = z.infer<typeof dbQueryWorkflowInputSchema>;

// ─── Workflow Output Schema ─────────────────────────────────────────────────

export const dbQueryWorkflowOutputSchema = z.object({
  datasetId: z.string().optional(),
  sql: z.string().optional(),
  description: z.string().optional(),
  resultArray: z.array(looseObjectSchema).optional(),
  replyToUser: z.string().optional(),
  fromCache: z.boolean().optional(),
  done: z.boolean().optional(),
});

export type DbQueryWorkflowOutput = z.infer<typeof dbQueryWorkflowOutputSchema>;

// ─── Internal Workflow State ────────────────────────────────────────────────

export const dbQueryWorkflowStateSchema = z.object({
  // Input fields
  prompt: z.string(),
  schema: DatabaseSchemaZ,
  datasetId: z.string().optional(),
  directCall: z.boolean().optional(),

  // SQL generation
  sql: z.string().optional(),
  status: StatusSchema.optional(),
  description: z.string().optional(),

  // Discovery results
  sampleSql: z.string().optional(),
  sampleSqlPrompt: z.string().optional(),
  fromCache: z.boolean().optional(),
  fromTemplate: z.boolean().optional(),
  templateId: z.string().optional(),
  changeType: ChangeTypeSchema.optional(),

  // Validation
  validationChecklist: z.string().optional(),
  syntacticStatus: StatusSchema.optional(),
  syntacticFeedback: z.string().optional(),
  semanticStatus: StatusSchema.optional(),
  semanticFeedback: z.string().optional(),
  syntacticErrorTables: z.array(z.string()).optional(),
  semanticErrorTables: z.array(z.string()).optional(),

  // Retry tracking
  feedbacks: z.array(z.string()).optional(),
  fixAttempts: z.number().default(0),

  // Result
  replyToUser: z.string().optional(),
  done: z.boolean().optional(),
  resultArray: z.array(looseObjectSchema).optional(),
});

export type DbQueryWorkflowState = z.infer<typeof dbQueryWorkflowStateSchema>;

// ─── Routing Decision ───────────────────────────────────────────────────────

export type DiscoveryRoutingDecision =
  | 'from-cache'
  | 'from-template'
  | 'continue'
  | 'failed';

export type ValidationRoutingDecision =
  | 'accepted'
  | 'fix-query'
  | 'reselect-tables'
  | 'failed';

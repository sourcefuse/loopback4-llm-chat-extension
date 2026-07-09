import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {makeNodeShell} from '../../runtime/_node-shell';
import {
  MAX_VALIDATION_ATTEMPTS,
  branchCachedSchema,
  branchContinueSchema,
  branchTemplateSchema,
  dbQueryInputSchema,
  inputSchema,
  outputSchema,
} from './constants';
import {DbQueryNodes} from './nodes.enum';
import {checklistStateSchema} from './checklist.shared';
import {
  MAX_IMPROVE_ATTEMPTS,
  improveInputSchema,
  improveOutputSchema,
} from './improve.shared';

/**
 * The db-query graph — the Mastra successor of the LangGraph `DbQueryGraph`,
 * kept as ONE file like v3. Both the `get-data-as-dataset` and `improve-dataset`
 * tools call the single {@link dbQueryGraph}, whose entry node dispatches on
 * `datasetId` (absent → generate, present → improve) — the equivalent of
 * LangGraph's `IsImprovement` node at `START`.
 *
 * The generate path restores the v2 node topology 1:1: after table/checklist
 * setup it classifies the change, then loops
 * `SqlGeneration → parallel[SyntacticValidator, SemanticValidator,
 * GenerateDescription] → PostValidation` (the v2 PreValidation fan-out +
 * PostValidation merge) inside a Mastra `.dountil`. Each node is a DI shell that
 * resolves its `@graphNode(key)` class; the LLM/validation logic lives in the
 * overridable `SqlGenerationHelper` / `SqlValidatorService` services.
 *
 * A loosely-typed loop-carry record flows between iterations
 * (`z.record`) — the fields are documented on `SqlLoopState`
 * (`nodes/sql-generation.node.ts`).
 */
const loopState = z.record(z.string(), z.unknown());
const verdictSchema = z.object({
  passed: z.boolean(),
  feedback: z.string().optional(),
});

// ── Generate path — pre-loop steps ───────────────────────────────────────────
export const checkCacheNode = makeNodeShell({
  id: DbQueryNodes.CheckCache,
  inputSchema,
  outputSchema: z.object({
    cacheHit: z.boolean(),
    datasetId: z.string().optional(),
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
});
export const getTablesNode = makeNodeShell({
  id: DbQueryNodes.GetTables,
  inputSchema,
  outputSchema: z.object({tables: z.array(z.string())}),
});
export const checkTemplatesNode = makeNodeShell({
  id: DbQueryNodes.CheckTemplates,
  inputSchema,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
});
export const postCacheAndTablesNode = makeNodeShell({
  id: DbQueryNodes.PostCacheAndTables,
  inputSchema: z.any(),
  outputSchema: z.object({
    fromCache: z.boolean(),
    fromTemplate: z.boolean(),
    status: z.enum(['AsIs', 'FromTemplate', 'Failed', 'Continue']),
    tables: z.array(z.string()),
    templateId: z.string().optional(),
    datasetId: z.string().optional(),
    prompt: z.string(),
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
});
export const returnCachedNode = makeNodeShell({
  id: DbQueryNodes.ReturnCached,
  inputSchema: z.any(),
  outputSchema: branchCachedSchema,
});
export const saveDatasetFromTemplateNode = makeNodeShell({
  id: DbQueryNodes.SaveFromTemplate,
  inputSchema: z.any(),
  outputSchema: branchTemplateSchema,
});
export const getColumnsNode = makeNodeShell({
  id: DbQueryNodes.GetColumns,
  inputSchema: z.any(),
  outputSchema: branchContinueSchema,
});
export const generateChecklistNode = makeNodeShell({
  id: DbQueryNodes.GenerateChecklist,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: checklistStateSchema,
});
export const verifyChecklistNode = makeNodeShell({
  id: DbQueryNodes.VerifyChecklist,
  inputSchema: checklistStateSchema,
  outputSchema: checklistStateSchema,
});

// ── Generate path — the validate loop (v2 node topology, restored) ────────────
export const classifyChangeNode = makeNodeShell({
  id: DbQueryNodes.ClassifyChange,
  inputSchema: loopState,
  outputSchema: loopState,
});
export const sqlGenerationNode = makeNodeShell({
  id: DbQueryNodes.SqlGeneration,
  inputSchema: loopState,
  outputSchema: loopState,
});
export const syntacticValidatorNode = makeNodeShell({
  id: DbQueryNodes.SyntacticValidator,
  inputSchema: loopState,
  outputSchema: z.object({syntactic: verdictSchema}),
});
export const semanticValidatorNode = makeNodeShell({
  id: DbQueryNodes.SemanticValidator,
  inputSchema: loopState,
  outputSchema: z.object({semantic: verdictSchema}),
});
export const generateDescriptionNode = makeNodeShell({
  id: DbQueryNodes.GenerateDescription,
  inputSchema: loopState,
  outputSchema: z.object({description: z.string()}),
});
export const postValidationNode = makeNodeShell({
  id: DbQueryNodes.PostValidation,
  inputSchema: loopState,
  outputSchema: z.object({
    sql: z.string(),
    passed: z.boolean(),
    attempts: z.number(),
    feedback: z.string().optional(),
    description: z.string(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
    cached: z.boolean().optional(),
    datasetId: z.string().optional(),
    unanswerable: z.boolean().optional(),
    replyToUser: z.string().optional(),
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
});

// v2 PreValidation fan-out (SqlGeneration → parallel validators + description)
// + PostValidation merge, as ONE Mastra step so `.dountil` can repeat it.
const sqlGenValidateGraph = createWorkflow({
  id: 'sql-gen-validate',
  inputSchema: loopState,
  outputSchema: postValidationNode.outputSchema,
})
  .then(sqlGenerationNode)
  .parallel([
    syntacticValidatorNode,
    semanticValidatorNode,
    generateDescriptionNode,
  ])
  .then(postValidationNode)
  .commit();

// ── Generate path — terminals ─────────────────────────────────────────────────
export const saveDatasetNode = makeNodeShell({
  id: DbQueryNodes.SaveDataset,
  inputSchema: z.any(),
  outputSchema,
});
export const failedNode = makeNodeShell({
  id: DbQueryNodes.Failed,
  inputSchema: z.any(),
  outputSchema,
});

export const generateQueryGraph = createWorkflow({
  id: 'generate-query',
  inputSchema,
  outputSchema,
})
  .parallel([checkCacheNode, getTablesNode, checkTemplatesNode])
  .then(postCacheAndTablesNode)
  .branch([
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'FromTemplate',
      saveDatasetFromTemplateNode,
    ],
    [
      async ({inputData}) => (inputData as {status?: string}).status === 'AsIs',
      returnCachedNode,
    ],
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'Continue',
      getColumnsNode,
    ],
  ])
  .then(generateChecklistNode)
  .then(verifyChecklistNode)
  .then(classifyChangeNode)
  .dountil(
    sqlGenValidateGraph,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_VALIDATION_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedNode,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveDatasetNode,
    ],
  ])
  .commit();

// ── Improve path ─────────────────────────────────────────────────────────────
// The improve terminal step keeps the Mastra id 'failed' (DbQueryNodes.Failed)
// within its sub-graph but resolves under the globally-unique DI key
// 'improve_failed' (DbQueryNodes.ImproveFailed).
export const loadExistingNode = makeNodeShell({
  id: DbQueryNodes.LoadExisting,
  inputSchema: improveInputSchema,
  outputSchema: z.object({
    datasetId: z.string(),
    prompt: z.string(),
    originalPrompt: z.string().optional(),
    originalSql: z.string().optional(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
    loadError: z.boolean().optional(),
  }),
});
export const fixQueryNode = makeNodeShell({
  id: DbQueryNodes.FixQuery,
  inputSchema: z.any(),
  outputSchema: z.object({
    datasetId: z.string(),
    sql: z.string(),
    passed: z.boolean(),
    attempts: z.number(),
    feedback: z.string().optional(),
    description: z.string().optional(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
  }),
});
export const saveImprovedNode = makeNodeShell({
  id: DbQueryNodes.SaveImproved,
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
});
export const improveFailedNode = makeNodeShell({
  id: DbQueryNodes.Failed,
  inputSchema: z.any(),
  outputSchema: improveOutputSchema,
  resolverKey: DbQueryNodes.ImproveFailed,
});

export const improveQueryGraph = createWorkflow({
  id: 'improve-query',
  inputSchema: improveInputSchema,
  outputSchema: improveOutputSchema,
})
  .then(loadExistingNode)
  .dountil(
    fixQueryNode,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_IMPROVE_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      improveFailedNode,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveImprovedNode,
    ],
  ])
  .commit();

// ── Entry graph (single entry both tools call) ───────────────────────────────
export const isImprovementNode = makeNodeShell({
  id: DbQueryNodes.IsImprovement,
  inputSchema: dbQueryInputSchema,
  outputSchema,
});

export const dbQueryGraph = createWorkflow({
  id: 'db-query',
  inputSchema: dbQueryInputSchema,
  outputSchema,
})
  .then(isImprovementNode)
  .commit();

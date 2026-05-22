import type {Context} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import type {SchemaStore} from '../../../components/db-query/services/schema.store';

/**
 * `generateQueryWorkflow` — Mastra port of the 17-node LangGraph
 * DbQueryGraph that builds a SQL dataset from a natural-language prompt.
 * See MIGRATION-STRATEGY.md Section 9.1.
 *
 * P3 scope: structural DAG only. WorkflowRunner enriches RequestContext
 * with `lb4Ctx` (full LB4 Context), `dbConnector`, `chatLlm` and
 * `eventWriter` so each step can resolve the preserved helpers
 * (DbSchemaHelperService, SchemaStore, TableSearchService,
 * PermissionHelper, DataSetHelper, TemplateHelper) lazily.
 *
 * **Real step bodies — restore strategy:** the LangGraph node sources
 * lived at `src/components/db-query/nodes/<name>.node.ts` before
 * commit 4be9767. `git show 4be9767^:src/components/db-query/nodes/<x>.node.ts`
 * pulls each one back. Each node's `.execute(state, config)` body
 * maps 1:1 to the corresponding step's `execute({inputData,
 * requestContext})`. Replace the stub bodies below in the same order
 * the v2 graph traversed: IsImprovement -> CheckCache / GetTables /
 * CheckTemplates / ClassifyChange -> PostCacheAndTables -> branch ->
 * GetColumns -> GenerateChecklist -> dountil(SqlAndValidate ==
 * SqlGeneration + Syntactic + Semantic + GenerateDescription +
 * VerifyChecklist) -> branch -> SaveDataset | Failed.
 */

const inputSchema = z.object({
  prompt: z.string(),
});

const outputSchema = z.object({
  datasetId: z.string(),
  sql: z.string(),
  rowCount: z.number(),
});

const isImprovementStep = createStep({
  id: 'is-improvement',
  inputSchema,
  outputSchema: inputSchema.extend({isImprovement: z.boolean()}),
  execute: async ({inputData}) => ({...inputData, isImprovement: false}),
});

const parallelInput = inputSchema.extend({isImprovement: z.boolean()});

const checkCacheStep = createStep({
  id: 'check-cache',
  inputSchema: parallelInput,
  outputSchema: z.object({
    cacheHit: z.boolean(),
    datasetId: z.string().optional(),
  }),
  execute: async () => ({cacheHit: false}),
});

/**
 * get-tables — wired example showing the helper-resolution pattern.
 * WorkflowRunner placed `lb4Ctx` (full LB4 Context) on requestContext.
 * Steps that need preserved helpers resolve them lazily here.
 *
 * Current body returns the raw table list from SchemaStore (populated
 * upstream by the consumer-side schema-seed observer / migrator). The
 * LLM-driven relevance filtering — PromptTemplate + CheapLLM chain
 * restored from `git show 4be9767^:src/components/db-query/nodes/get-tables.node.ts`
 * — lands in the follow-up commit. The deterministic baseline gives
 * downstream steps a real list of table names instead of an empty
 * array, so the rest of the workflow can be reasoned about.
 */
const getTablesStep = createStep({
  id: 'get-tables',
  inputSchema: parallelInput,
  outputSchema: z.object({tables: z.array(z.string())}),
  execute: async ({requestContext}) => {
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx) return {tables: []};
    const schemaStore = await lb4Ctx.get<SchemaStore>('services.SchemaStore', {
      optional: true,
    });
    if (!schemaStore) return {tables: []};
    try {
      const schema = schemaStore.get();
      return {tables: Object.keys(schema.tables)};
    } catch {
      // schema not yet loaded — caller (or a follow-up loadSchemaStep)
      // must populate SchemaStore before the workflow runs.
      return {tables: []};
    }
  },
});

const checkTemplatesStep = createStep({
  id: 'check-templates',
  inputSchema: parallelInput,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
  execute: async () => ({matched: false}),
});

const classifyChangeStep = createStep({
  id: 'classify-change',
  inputSchema: parallelInput,
  outputSchema: z.object({changeType: z.string().optional()}),
  execute: async () => ({changeType: undefined}),
});

const postCacheAndTablesStep = createStep({
  id: 'post-cache-and-tables',
  inputSchema: z.any(),
  outputSchema: z.object({
    fromCache: z.boolean(),
    fromTemplate: z.boolean(),
    status: z.enum(['AsIs', 'FromTemplate', 'Failed', 'Continue']),
    tables: z.array(z.string()),
    templateId: z.string().optional(),
    datasetId: z.string().optional(),
    prompt: z.string(),
  }),
  execute: async ({getStepResult, inputData}) => {
    const cache = (getStepResult('check-cache') ?? {cacheHit: false}) as {
      cacheHit: boolean;
      datasetId?: string;
    };
    const tables = (getStepResult('get-tables') ?? {tables: []}) as {
      tables: string[];
    };
    const templates = (getStepResult('check-templates') ?? {
      matched: false,
    }) as {matched: boolean; templateId?: string};
    return {
      fromCache: cache.cacheHit,
      fromTemplate: templates.matched,
      status: cache.cacheHit
        ? 'AsIs'
        : templates.matched
          ? 'FromTemplate'
          : 'Continue',
      tables: tables.tables,
      templateId: templates.templateId,
      datasetId: cache.datasetId,
      prompt: (inputData as {prompt?: string})?.prompt ?? '',
    };
  },
});

const returnCachedStep = createStep({
  id: 'return-cached',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData}) => ({
    datasetId: (inputData as {datasetId?: string})?.datasetId ?? '',
    sql: '',
    rowCount: 0,
  }),
});

const saveDatasetFromTemplateStep = createStep({
  id: 'save-dataset-from-template',
  inputSchema: z.any(),
  outputSchema,
  execute: async () => ({datasetId: '', sql: '', rowCount: 0}),
});

const failedStep = createStep({
  id: 'failed',
  inputSchema: z.any(),
  outputSchema,
  execute: async () => ({datasetId: '', sql: '', rowCount: 0}),
});

const getColumnsStep = createStep({
  id: 'get-columns',
  inputSchema: z.any(),
  outputSchema: z.object({
    prompt: z.string(),
    tables: z.array(z.string()),
    templateId: z.string().optional(),
  }),
  execute: async ({inputData}) => ({
    prompt: (inputData as {prompt?: string})?.prompt ?? '',
    tables: (inputData as {tables?: string[]})?.tables ?? [],
    templateId: (inputData as {templateId?: string})?.templateId,
  }),
});

const generateChecklistStep = createStep({
  id: 'generate-checklist',
  // After `.branch()` Mastra wraps the matched branch's output under the
  // branch step's id (mirroring the .parallel() fan-in shape). The body
  // unwraps defensively so generateChecklist runs regardless of which
  // branch fired.
  inputSchema: z.any(),
  outputSchema: z.object({
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
  }),
  execute: async ({inputData}) => {
    const wrapped = inputData as Record<string, unknown>;
    const fromGetColumns = wrapped['get-columns'] as
      | {prompt?: string; tables?: string[]}
      | undefined;
    return {
      prompt:
        fromGetColumns?.prompt ?? (wrapped.prompt as string | undefined) ?? '',
      tables:
        fromGetColumns?.tables ??
        (wrapped.tables as string[] | undefined) ??
        [],
      checklist: '',
      attempts: 0,
    };
  },
});

const sqlAndValidateStep = createStep({
  id: 'sql-and-validate',
  // Loose input schema: dountil feeds this step its own output on each
  // iteration after the first, but on iter 0 the upstream step's payload
  // arrives — schema unions across the two are awkward in zod, so the
  // step body destructures defensively instead.
  inputSchema: z.any(),
  outputSchema: z.object({
    sql: z.string(),
    passed: z.boolean(),
    attempts: z.number(),
    feedback: z.string().optional(),
    description: z.string(),
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
  }),
  execute: async ({inputData}) => {
    const data = inputData as {
      prompt?: string;
      tables?: string[];
      checklist?: string;
      feedback?: string;
      attempts?: number;
    };
    return {
      sql: '',
      passed: true,
      attempts: (data.attempts ?? 0) + 1,
      feedback: undefined,
      description: '',
      prompt: data.prompt ?? '',
      tables: data.tables ?? [],
      checklist: data.checklist ?? '',
    };
  },
});

const saveDatasetStep = createStep({
  id: 'save-dataset',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData}) => ({
    datasetId: '',
    sql: (inputData as {sql?: string})?.sql ?? '',
    rowCount: 0,
  }),
});

export const generateQueryWorkflow = createWorkflow({
  id: 'generate-query',
  inputSchema,
  outputSchema,
})
  .then(isImprovementStep)
  .parallel([
    checkCacheStep,
    getTablesStep,
    checkTemplatesStep,
    classifyChangeStep,
  ])
  .then(postCacheAndTablesStep)
  .branch([
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'FromTemplate',
      saveDatasetFromTemplateStep,
    ],
    [
      async ({inputData}) => (inputData as {status?: string}).status === 'AsIs',
      returnCachedStep,
    ],
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'Failed',
      failedStep,
    ],
    [async () => true, getColumnsStep],
  ])
  .then(generateChecklistStep)
  .dountil(
    sqlAndValidateStep,
    async ({inputData}) => inputData.passed || inputData.attempts >= 3,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedStep,
    ],
    [async () => true, saveDatasetStep],
  ])
  .commit();

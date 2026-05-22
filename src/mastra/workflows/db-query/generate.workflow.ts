import type {Context} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {generateText} from 'ai';
import type {LanguageModel} from 'ai';
import {AuthenticationBindings} from 'loopback4-authentication';
import {z} from 'zod';
import {DbQueryAIExtensionBindings} from '../../../components/db-query/keys';
import type {DbSchemaHelperService} from '../../../components/db-query/services';
import type {SchemaStore} from '../../../components/db-query/services/schema.store';
import type {IDataSetStore} from '../../../components/db-query/types';

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

/**
 * classify-change — wired with LLM. Only active when the generate
 * workflow is invoked with an existing sample SQL (currently
 * isImprovementStep returns isImprovement=false for the entry
 * generate workflow, so this step routinely sits as a no-op — the
 * improve workflow is the live caller). Restored from
 * `git show 4be9767^:src/components/db-query/nodes/classify-change.node.ts`.
 */
const classifyChangeStep = createStep({
  id: 'classify-change',
  inputSchema: parallelInput,
  outputSchema: z.object({changeType: z.string().optional()}),
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      prompt?: string;
      sampleSqlPrompt?: string;
      isImprovement?: boolean;
    };
    if (!data.isImprovement) return {changeType: undefined};
    const chatLlm = requestContext?.get('chatLlm') as LanguageModel | undefined;
    if (!chatLlm) return {changeType: undefined};
    const llmPrompt = `You are given the original description of a SQL query and a new description that includes user feedback.
Classify the level of change required to transform the original query into the new one.

Original description: ${data.sampleSqlPrompt ?? ''}
New description: ${data.prompt ?? ''}

Return ONLY one of: minor, major, rewrite`;
    try {
      const result = await generateText({model: chatLlm, prompt: llmPrompt});
      const text = result.text.trim().toLowerCase();
      if (text.includes('minor')) return {changeType: 'minor'};
      if (text.includes('rewrite')) return {changeType: 'rewrite'};
      return {changeType: 'major'};
    } catch {
      return {changeType: undefined};
    }
  },
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

/**
 * return-cached — wired. When postCacheAndTablesStep classifies status
 * as 'AsIs' (cache hit), this step resolves the cached dataset row via
 * IDataSetStore.findById so downstream consumers see the real sql +
 * tenant-owned tables without re-running SQL generation.
 */
const returnCachedStep = createStep({
  id: 'return-cached',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {datasetId?: string};
    const fallback = {datasetId: data.datasetId ?? '', sql: '', rowCount: 0};
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx || !data.datasetId) return fallback;
    const store = await lb4Ctx.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
      {optional: true},
    );
    if (!store) return fallback;
    try {
      const dataset = await store.findById(data.datasetId);
      return {
        datasetId: dataset.id ?? data.datasetId,
        sql: dataset.query ?? '',
        rowCount: 0,
      };
    } catch {
      return fallback;
    }
  },
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

/**
 * get-columns — wired with LLM. Asks the chat model to narrow down
 * the column set per table to those relevant to the user's query.
 * Simplified vs v2 GetColumnsNode: we don't yet feed the per-table
 * column metadata to the model (the SchemaStore-cached schema is
 * passed as a flat JSON blob); the JSON-output parse + retry loop
 * lands later. Falls through to the upstream table list when no
 * chatLlm is bound or parsing fails so the downstream
 * generate-checklist + sql-and-validate stages still receive real
 * table names.
 */
const getColumnsStep = createStep({
  id: 'get-columns',
  inputSchema: z.any(),
  outputSchema: z.object({
    prompt: z.string(),
    tables: z.array(z.string()),
    templateId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      prompt?: string;
      tables?: string[];
      templateId?: string;
    };
    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const templateId = data.templateId;
    // Without lb4Ctx or chatLlm we can't enrich — pass through.
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    const chatLlm = requestContext?.get('chatLlm') as LanguageModel | undefined;
    if (!lb4Ctx || !chatLlm || tables.length === 0) {
      return {prompt, tables, templateId};
    }
    const schemaStore = await lb4Ctx.get<SchemaStore>('services.SchemaStore', {
      optional: true,
    });
    const tablesWithColumns: Record<string, string[]> = {};
    try {
      const schema = schemaStore?.filteredSchema(tables);
      if (schema) {
        for (const [tableName, tableDef] of Object.entries(schema.tables)) {
          tablesWithColumns[tableName] = Object.keys(
            (tableDef as {columns?: Record<string, unknown>}).columns ?? {},
          );
        }
      }
    } catch {
      // schema not loaded
    }
    if (Object.keys(tablesWithColumns).length === 0) {
      return {prompt, tables, templateId};
    }
    const llmPrompt = `You are an AI assistant that identifies relevant columns from database tables based on a user's query.
Return a JSON object where each table name is a key and the value is an array of relevant column names.

Tables with columns:
${JSON.stringify(tablesWithColumns, null, 2)}

User query: ${prompt}

Return ONLY valid JSON. Include primary-key and foreign-key columns even if not directly mentioned.`;
    try {
      const result = await generateText({model: chatLlm, prompt: llmPrompt});
      const cleaned = result.text.trim().replace(/^```json\s*|\s*```$/g, '');
      const parsed = JSON.parse(cleaned) as Record<string, string[]>;
      const filteredTables = Object.keys(parsed).filter(t =>
        tables.includes(t),
      );
      return {
        prompt,
        tables: filteredTables.length > 0 ? filteredTables : tables,
        templateId,
      };
    } catch {
      // Parse failure — fall through to upstream tables verbatim.
      return {prompt, tables, templateId};
    }
  },
});

/**
 * generate-checklist — wired with LLM. Asks the chat model to produce
 * a short bulleted validation checklist for the upcoming SQL
 * generation, given the user prompt and the chosen tables. Mirrors v2
 * GenerateChecklistNode body (`git show 4be9767^:src/components/db-query/nodes/generate-checklist.node.ts`)
 * minus the structured-output coercion.
 *
 * After `.branch()` Mastra wraps the matched branch's output under the
 * branch step's id (mirroring the .parallel() fan-in shape). The body
 * unwraps defensively so the step runs regardless of which branch
 * fired.
 */
const generateChecklistStep = createStep({
  id: 'generate-checklist',
  inputSchema: z.any(),
  outputSchema: z.object({
    prompt: z.string(),
    tables: z.array(z.string()),
    checklist: z.string(),
    attempts: z.number(),
  }),
  execute: async ({inputData, requestContext}) => {
    const wrapped = inputData as Record<string, unknown>;
    const fromGetColumns = wrapped['get-columns'] as
      | {prompt?: string; tables?: string[]}
      | undefined;
    const prompt =
      fromGetColumns?.prompt ?? (wrapped.prompt as string | undefined) ?? '';
    const tables =
      fromGetColumns?.tables ?? (wrapped.tables as string[] | undefined) ?? [];
    const chatLlm = requestContext?.get('chatLlm') as LanguageModel | undefined;
    let checklist = '';
    if (chatLlm && prompt) {
      const llmPrompt = `You are an AI assistant. Produce a concise bullet-list checklist (3-6 items) of constraints the SQL query about to be generated must satisfy.

User request: ${prompt}
Available tables: ${tables.join(', ') || '(none)'}

Return ONLY the checklist as plain text bullets, no preamble.`;
      try {
        const result = await generateText({model: chatLlm, prompt: llmPrompt});
        checklist = result.text.trim();
      } catch {
        // LLM unavailable / failed — proceed with empty checklist so
        // the dountil loop can still attempt SQL generation.
      }
    }
    return {prompt, tables, checklist, attempts: 0};
  },
});

/**
 * sql-and-validate — wired with LLM. Composite step that generates
 * SQL via the chat model and (in a follow-up commit) runs the
 * syntactic + semantic validators in parallel. For now the step does
 * SQL generation only and marks passed=true so the dountil loop exits
 * after the first iteration. The validator wiring follows the same
 * generateText pattern with bespoke prompts restored from
 * `git show 4be9767^:src/components/db-query/nodes/{syntactic,semantic}-validator.node.ts`.
 */
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
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      prompt?: string;
      tables?: string[];
      checklist?: string;
      feedback?: string;
      attempts?: number;
    };
    const chatLlm = requestContext?.get('chatLlm') as LanguageModel | undefined;
    let sql = '';
    let description = '';
    let passed = true;
    let feedback: string | undefined;
    if (chatLlm && data.prompt) {
      const llmPrompt = `You are a SQL expert. Generate a single ANSI SQL query that satisfies the user's request.

User request: ${data.prompt}
Allowed tables: ${(data.tables ?? []).join(', ') || '(any)'}
Validation checklist:
${data.checklist ?? '(none)'}
${
  data.feedback
    ? `Previous attempt was rejected with the following feedback that you must address: ${data.feedback}`
    : ''
}

Return ONLY the SQL statement. No explanation, no markdown fences, no comments.`;
      try {
        const result = await generateText({model: chatLlm, prompt: llmPrompt});
        sql = result.text.trim().replace(/^```sql\s*|\s*```$/g, '');
        description = `Generated SQL for: ${data.prompt}`;
      } catch (err) {
        passed = false;
        feedback = (err as Error).message;
      }
    } else {
      // No LLM bound — preserve loop-exit behaviour so callers in
      // test / dry-run mode still complete with a documented stub.
      passed = true;
    }
    return {
      sql,
      passed,
      attempts: (data.attempts ?? 0) + 1,
      feedback,
      description,
      prompt: data.prompt ?? '',
      tables: data.tables ?? [],
      checklist: data.checklist ?? '',
    };
  },
});

/**
 * save-dataset — wired. Mirrors the storage half of v2 SaveDataSetNode
 * (`git show 4be9767^:src/components/db-query/nodes/save-dataset-node.ts`)
 * minus the LLM-driven description generation, which is deferred to
 * the future generate-description step inside the dountil composite.
 * The LLM-free path is enough to land real datasets when callers
 * supply a description (the v2 GenerateDescription node populated it).
 */
const saveDatasetStep = createStep({
  id: 'save-dataset',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      sql?: string;
      description?: string;
      prompt?: string;
      tables?: string[];
    };
    const fallback = {
      datasetId: '',
      sql: data.sql ?? '',
      rowCount: 0,
    };
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx || !data.sql) return fallback;
    const store = await lb4Ctx.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
      {optional: true},
    );
    const user = await lb4Ctx.get<IAuthUserWithPermissions>(
      AuthenticationBindings.CURRENT_USER,
      {optional: true},
    );
    if (!store || !user?.tenantId) return fallback;
    const schemaHelper = await lb4Ctx.get<DbSchemaHelperService>(
      'services.DbSchemaHelperService',
      {optional: true},
    );
    const schemaStore = await lb4Ctx.get<SchemaStore>('services.SchemaStore', {
      optional: true,
    });
    let schemaHash = '';
    let tableList = data.tables ?? [];
    try {
      const schema = schemaStore?.get();
      if (schema && schemaHelper) {
        schemaHash = schemaHelper.computeHash(schema);
        if (!tableList.length) tableList = Object.keys(schema.tables);
      }
    } catch {
      // schema not loaded — keep schemaHash empty.
    }
    const dataset = await store.create({
      tenantId: user.tenantId,
      query: data.sql,
      description: data.description ?? '',
      prompt: data.prompt ?? '',
      tables: tableList,
      schemaHash,
      votes: 0,
    });
    return {datasetId: dataset.id ?? '', sql: data.sql, rowCount: 0};
  },
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

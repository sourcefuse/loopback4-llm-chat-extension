import {createStep, createWorkflow} from '@mastra/core/workflows';
import {generateText} from 'ai';
import {z} from 'zod';
import {
  buildGenerateSqlPrompt,
  computeSchemaHash,
  getAuthUser,
  getChatLlm,
  getDatasetStore,
  getDbConnector,
  getQueryCache,
  getSchemaHelper,
  getSchemaStore,
  getTablesWithColumns,
  getTemplateCache,
  getTemplateHelper,
  getTemplateStore,
  pickRelevantTables,
  resolvePersistDeps,
  resolveTemplateById,
  runSqlAttempt,
} from './_helpers';

const MAX_VALIDATION_ATTEMPTS = 3;

/** Workflow status enum exported so the post-cache step's union type
 * stays under SonarQube's S4622 threshold (max 2 unions inline). */
type DbQueryStatus = 'AsIs' | 'FromTemplate' | 'Failed' | 'Continue';

function classifyPostCacheStatus(
  cacheHit: boolean,
  templateMatched: boolean,
): DbQueryStatus {
  if (cacheHit) return 'AsIs';
  if (templateMatched) return 'FromTemplate';
  return 'Continue';
}

/**
 * `generateQueryWorkflow` — Mastra port of the 17-node LangGraph
 * DbQueryGraph that builds a SQL dataset from a natural-language prompt.
 * See the migration plan.
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

// `isImprovementStep` + `classifyChangeStep` lived here in earlier
// drafts but never fired meaningful logic for generateQueryWorkflow:
// the improve flow runs in its own improveQueryWorkflow (entry path
// owns the original-SQL merge + change-type classification). Removed
// so generate workflow stays free of dead branches; if a future
// orchestrator needs the unified mode-detection step, lift it into
// _helpers.ts and reuse.

/**
 * check-cache — wired with retriever + LLM judge. Resolves the
 * QueryCache LangChain retriever via lb4Ctx, pulls candidate cached
 * datasets via semantic similarity, then asks the chat model whether
 * any candidate satisfies the new prompt exactly (`AsIs`),
 * approximately (`Similar`), or not at all (`NotRelevant`). Mirrors v2
 * CheckCacheNode (`git show 4be9767^:src/components/db-query/nodes/check-cache.node.ts`).
 */
const checkCacheStep = createStep({
  id: 'check-cache',
  inputSchema,
  outputSchema: z.object({
    cacheHit: z.boolean(),
    datasetId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {prompt?: string};
    if (!data.prompt) return {cacheHit: false};
    const cache = getQueryCache(requestContext);
    const chatLlm = getChatLlm(requestContext);
    if (!cache || !chatLlm) return {cacheHit: false};
    let docs: Array<{pageContent: string; metadata: {id?: string}}> = [];
    try {
      docs = await cache.invoke(data.prompt);
    } catch {
      return {cacheHit: false};
    }
    if (docs.length === 0) return {cacheHit: false};
    const queries = docs.map((d, i) => `${i + 1}. ${d.pageContent}`).join('\n');
    const judgePrompt = `You are a semantic analyser. Given a user's prompt and a list of past prompts that were handled, return the most relevant past prompt and how it relates.
- Return 'AsIs <index>' when the past prompt's result fully answers the new prompt without changes.
- Return 'Similar <index>' when it is close but needs modification.
- Return 'NotRelevant' when nothing fits.

User prompt: ${data.prompt}
Past prompts:
${queries}

Return ONLY the verdict, no other text.`;
    try {
      const verdict = await generateText({model: chatLlm, prompt: judgePrompt});
      const text = verdict.text.trim();
      const match = text.match(/AsIs\s+(\d+)/i);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        const doc = docs[idx];
        if (doc?.metadata?.id) {
          return {cacheHit: true, datasetId: doc.metadata.id};
        }
      }
    } catch {
      // judge LLM failed — degrade to cacheHit=false.
    }
    return {cacheHit: false};
  },
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
  inputSchema,
  outputSchema: z.object({tables: z.array(z.string())}),
  execute: async ({requestContext}) => {
    const schemaStore = getSchemaStore(requestContext);
    if (!schemaStore) return {tables: []};
    try {
      const schema = schemaStore.get();
      return {tables: Object.keys(schema.tables)};
    } catch {
      // schema not yet loaded — caller must populate SchemaStore
      // before the workflow runs.
      return {tables: []};
    }
  },
});

/**
 * check-templates — wired with retriever + LLM judge. Resolves the
 * TemplateCache LangChain retriever via lb4Ctx, pulls candidate
 * pre-authored templates via semantic similarity, then asks the chat
 * model whether one exactly matches the user's intent. Mirrors v2
 * CheckTemplatesNode (`git show 4be9767^:src/components/db-query/nodes/check-templates.node.ts`).
 * The placeholder-extraction half (TemplateHelper.extractPlaceholderValues)
 * still runs only inside save-dataset-from-template, where the
 * matched template id is consumed.
 */
const checkTemplatesStep = createStep({
  id: 'check-templates',
  inputSchema,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {prompt?: string};
    if (!data.prompt) return {matched: false};
    const cache = getTemplateCache(requestContext);
    const chatLlm = getChatLlm(requestContext);
    if (!cache || !chatLlm) return {matched: false};
    let docs: Array<{pageContent: string; metadata: {id?: string}}> = [];
    try {
      docs = await cache.invoke(data.prompt);
    } catch {
      return {matched: false};
    }
    if (docs.length === 0) return {matched: false};
    const templates = docs
      .map((d, i) => `${i + 1}. ${d.pageContent}`)
      .join('\n');
    const judgePrompt = `You are an expert at matching user prompts to query templates. A template matches ONLY when its purpose and result are EXACTLY what the user asked — no extra columns, no missing filters, only placeholder values differ.

User prompt: ${data.prompt}
Templates:
${templates}

Return 'match <index>' for an exact match or 'no_match'. No other text.`;
    try {
      const verdict = await generateText({model: chatLlm, prompt: judgePrompt});
      const text = verdict.text.trim();
      const match = text.match(/match\s+(\d+)/i);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        const doc = docs[idx];
        if (doc?.metadata?.id) {
          return {matched: true, templateId: doc.metadata.id};
        }
      }
    } catch {
      // judge LLM failed — degrade to matched=false.
    }
    return {matched: false};
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
  execute: async ({getStepResult, getInitData, inputData}) => {
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
    // After `.parallel()`, `inputData` is the parallel-step output map keyed by
    // step ids — the workflow's initial `{prompt, ...}` payload is no longer
    // visible there. Read the prompt from `getInitData()` so downstream steps
    // (sql-and-validate, save-dataset) see a non-empty prompt.
    const init = (getInitData?.() ?? {}) as {prompt?: string};
    const prompt =
      init.prompt ?? (inputData as {prompt?: string})?.prompt ?? '';
    return {
      fromCache: cache.cacheHit,
      fromTemplate: templates.matched,
      status: classifyPostCacheStatus(cache.cacheHit, templates.matched),
      tables: tables.tables,
      templateId: templates.templateId,
      datasetId: cache.datasetId,
      prompt,
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
    const store = getDatasetStore(requestContext);
    if (!store || !data.datasetId) return fallback;
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

/**
 * save-dataset-from-template — wired. Fetches the matched template via
 * IQueryTemplateStore.findById, runs TemplateHelper.resolveTemplate to
 * extract placeholder values from the user's prompt + substitute them
 * into the template SQL, then persists the result as a new dataset
 * row. Mirrors the v2 graph's `FromTemplate` branch path.
 */
const saveDatasetFromTemplateStep = createStep({
  id: 'save-dataset-from-template',
  inputSchema: z.any(),
  outputSchema,
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {
      templateId?: string;
      prompt?: string;
      tables?: string[];
    };
    const fallback = {datasetId: '', sql: '', rowCount: 0};
    if (!data.templateId || !data.prompt) return fallback;
    const persist = resolvePersistDeps(
      getDatasetStore(requestContext),
      getAuthUser(requestContext),
    );
    if (!persist) return fallback;
    const resolved = await resolveTemplateById({
      templateStore: getTemplateStore(requestContext),
      templateHelper: getTemplateHelper(requestContext),
      schemaStore: getSchemaStore(requestContext),
      templateId: data.templateId,
      prompt: data.prompt,
    });
    if (!resolved) return fallback;
    const {schemaHash} = computeSchemaHash(
      getSchemaHelper(requestContext),
      getSchemaStore(requestContext),
    );
    const dataset = await persist.store.create({
      tenantId: persist.user.tenantId,
      query: resolved.sql,
      description: resolved.description ?? '',
      prompt: data.prompt,
      tables: data.tables ?? [],
      schemaHash,
      votes: 0,
    });
    return {datasetId: dataset.id ?? '', sql: resolved.sql, rowCount: 0};
  },
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
    const chatLlm = getChatLlm(requestContext);
    if (!chatLlm || tables.length === 0) {
      return {prompt, tables, templateId};
    }
    const tablesWithColumns = getTablesWithColumns(
      getSchemaStore(requestContext),
      tables,
    );
    const narrowed = await pickRelevantTables({
      chatLlm,
      prompt,
      tablesWithColumns,
      upstreamTables: tables,
    });
    return {prompt, tables: narrowed ?? tables, templateId};
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
 * branch step's id (mirroring the.parallel() fan-in shape). The body
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
    const chatLlm = getChatLlm(requestContext);
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
    const prompt = data.prompt ?? '';
    const tables = data.tables ?? [];
    const columns = getTablesWithColumns(
      getSchemaStore(requestContext),
      tables,
    );
    const attempt = await runSqlAttempt({
      chatLlm: getChatLlm(requestContext),
      dbConnector: getDbConnector(requestContext),
      prompt,
      tables,
      columns,
      checklist: data.checklist,
      feedback: data.feedback,
      buildPrompt: buildGenerateSqlPrompt,
      buildDescription: (_sql, p) => `Generated SQL for: ${p}`,
    });
    return {
      sql: attempt.sql,
      passed: attempt.passed,
      attempts: (data.attempts ?? 0) + 1,
      feedback: attempt.feedback,
      description: attempt.description ?? '',
      prompt,
      tables,
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
    const fallback = {datasetId: '', sql: data.sql ?? '', rowCount: 0};
    if (!data.sql) return fallback;
    const persist = resolvePersistDeps(
      getDatasetStore(requestContext),
      getAuthUser(requestContext),
    );
    if (!persist) return fallback;
    const {schemaHash, tablesFromSchema} = computeSchemaHash(
      getSchemaHelper(requestContext),
      getSchemaStore(requestContext),
    );
    const tableList = data.tables?.length ? data.tables : tablesFromSchema;
    const dataset = await persist.store.create({
      tenantId: persist.user.tenantId,
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
  .parallel([checkCacheStep, getTablesStep, checkTemplatesStep])
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
    [
      async ({inputData}) =>
        (inputData as {status?: string}).status === 'Continue',
      getColumnsStep,
    ],
  ])
  .then(generateChecklistStep)
  .dountil(
    sqlAndValidateStep,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_VALIDATION_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedStep,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveDatasetStep,
    ],
  ])
  .commit();

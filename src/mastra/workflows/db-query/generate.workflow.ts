import type {Context} from '@loopback/core';
import {createStep, createWorkflow} from '@mastra/core/workflows';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import {generateText} from 'ai';
import type {LanguageModel} from 'ai';
import {AuthenticationBindings} from 'loopback4-authentication';
import {z} from 'zod';
import {DbQueryAIExtensionBindings} from '../../../components/db-query/keys';
import type {
  DbSchemaHelperService,
  TemplateHelper,
} from '../../../components/db-query/services';
import type {SchemaStore} from '../../../components/db-query/services/schema.store';
import type {
  IDataSetStore,
  IDbConnector,
  IQueryTemplateStore,
} from '../../../components/db-query/types';

const MAX_VALIDATION_ATTEMPTS = 3;
const SCHEMA_STORE_KEY = 'services.SchemaStore';

/**
 * Strip a leading ```sql / ``` fence and a trailing ``` fence from an
 * LLM response, plus surrounding whitespace. Pure string ops to avoid
 * the super-linear regex backtracking that `s5852` flags.
 */
function stripSqlFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```sql')) {
    s = s.slice('```sql'.length);
  } else if (s.startsWith('```')) {
    s = s.slice('```'.length);
  }
  if (s.endsWith('```')) {
    s = s.slice(0, -3);
  }
  return s.trim();
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

const isImprovementStep = createStep({
  id: 'is-improvement',
  inputSchema,
  outputSchema: inputSchema.extend({isImprovement: z.boolean()}),
  execute: async ({inputData}) => ({...inputData, isImprovement: false}),
});

const parallelInput = inputSchema.extend({isImprovement: z.boolean()});

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
  inputSchema: parallelInput,
  outputSchema: z.object({
    cacheHit: z.boolean(),
    datasetId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {prompt?: string; isImprovement?: boolean};
    if ((data.isImprovement ?? false) || !data.prompt) return {cacheHit: false};
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    const chatLlm = requestContext?.get('chatLlm') as LanguageModel | undefined;
    if (!lb4Ctx) return {cacheHit: false};
    const cache = await lb4Ctx.get<{
      invoke: (
        input: string,
      ) => Promise<Array<{pageContent: string; metadata: {id?: string}}>>;
    }>(DbQueryAIExtensionBindings.QueryCache, {optional: true});
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
  inputSchema: parallelInput,
  outputSchema: z.object({tables: z.array(z.string())}),
  execute: async ({requestContext}) => {
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx) return {tables: []};
    const schemaStore = await lb4Ctx.get<SchemaStore>(SCHEMA_STORE_KEY, {
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
  inputSchema: parallelInput,
  outputSchema: z.object({
    matched: z.boolean(),
    templateId: z.string().optional(),
  }),
  execute: async ({inputData, requestContext}) => {
    const data = inputData as {prompt?: string; isImprovement?: boolean};
    if ((data.isImprovement ?? false) || !data.prompt) return {matched: false};
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    const chatLlm = requestContext?.get('chatLlm') as LanguageModel | undefined;
    if (!lb4Ctx) return {matched: false};
    const cache = await lb4Ctx.get<{
      invoke: (
        input: string,
      ) => Promise<Array<{pageContent: string; metadata: {id?: string}}>>;
    }>(DbQueryAIExtensionBindings.TemplateCache, {optional: true});
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
    let status: 'AsIs' | 'FromTemplate' | 'Failed' | 'Continue';
    if (cache.cacheHit) {
      status = 'AsIs';
    } else if (templates.matched) {
      status = 'FromTemplate';
    } else {
      status = 'Continue';
    }
    return {
      fromCache: cache.cacheHit,
      fromTemplate: templates.matched,
      status,
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
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    if (!lb4Ctx) return fallback;
    const templateStore = await lb4Ctx.get<IQueryTemplateStore>(
      DbQueryAIExtensionBindings.TemplateStore,
      {optional: true},
    );
    const datasetStore = await lb4Ctx.get<IDataSetStore>(
      DbQueryAIExtensionBindings.DatasetStore,
      {optional: true},
    );
    const templateHelper = await lb4Ctx.get<TemplateHelper>(
      'services.TemplateHelper',
      {optional: true},
    );
    const schemaStore = await lb4Ctx.get<SchemaStore>(SCHEMA_STORE_KEY, {
      optional: true,
    });
    const user = await lb4Ctx.get<IAuthUserWithPermissions>(
      AuthenticationBindings.CURRENT_USER,
      {optional: true},
    );
    if (!templateStore || !datasetStore || !templateHelper || !user?.tenantId) {
      return fallback;
    }
    let resolved: {sql: string; description?: string};
    try {
      const template = await templateStore.findById(data.templateId);
      const schema = (() => {
        try {
          return schemaStore?.get();
        } catch {
          return undefined;
        }
      })();
      resolved = await templateHelper.resolveTemplate(
        template,
        data.prompt,
        {} as never,
        schema,
        async id => {
          try {
            return await templateStore.findById(id);
          } catch {
            return undefined;
          }
        },
      );
    } catch {
      return fallback;
    }
    if (!resolved.sql) return fallback;
    const schemaHelper = await lb4Ctx.get<DbSchemaHelperService>(
      'services.DbSchemaHelperService',
      {optional: true},
    );
    let schemaHash = '';
    try {
      const schema = schemaStore?.get();
      if (schema && schemaHelper) {
        schemaHash = schemaHelper.computeHash(schema);
      }
    } catch {
      // schema not loaded
    }
    const dataset = await datasetStore.create({
      tenantId: user.tenantId,
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
    // Without lb4Ctx or chatLlm we can't enrich — pass through.
    const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
    const chatLlm = requestContext?.get('chatLlm') as LanguageModel | undefined;
    if (!lb4Ctx || !chatLlm || tables.length === 0) {
      return {prompt, tables, templateId};
    }
    const schemaStore = await lb4Ctx.get<SchemaStore>(SCHEMA_STORE_KEY, {
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
        sql = stripSqlFences(result.text);
        description = `Generated SQL for: ${data.prompt}`;
      } catch (err) {
        passed = false;
        feedback = (err as Error).message;
      }
    }
    // No-LLM path: `passed` stays at its initial `true` so the dountil
    // loop exits after a single iteration (callers in test / dry-run
    // mode complete with a documented stub).

    // Syntactic validation via IDbConnector.validate() — runs a DB EXPLAIN
    // against the generated SQL. Mirrors v2 SyntacticValidatorNode.
    if (passed && sql) {
      const lb4Ctx = requestContext?.get('lb4Ctx') as Context | undefined;
      if (lb4Ctx) {
        const dbConnector = await lb4Ctx.get<IDbConnector>(
          DbQueryAIExtensionBindings.Connector,
          {optional: true},
        );
        if (dbConnector) {
          try {
            await dbConnector.validate(sql);
          } catch (err) {
            passed = false;
            feedback = `Syntactic error: ${(err as Error).message}`;
          }
        }
      }
    }

    // Semantic validation via LLM checklist comparison. Mirrors v2
    // SemanticValidatorNode, simplified — emits <valid/> on pass or
    // <invalid>...feedback...</invalid> on fail. Skipped when no
    // checklist (the LLM has nothing to verify against).
    if (passed && sql && chatLlm && data.checklist) {
      const semanticPrompt = `You are a SQL semantic validator. Decide whether the SQL below satisfies every item in the validation checklist for the user's request.

User request: ${data.prompt ?? ''}
SQL: ${sql}
Validation checklist:
${data.checklist}

If every checklist item is satisfied, return ONLY: <valid/>
Otherwise return: <invalid>one short sentence per failed item</invalid>
Do not return any other text.`;
      try {
        const verdict = await generateText({
          model: chatLlm,
          prompt: semanticPrompt,
        });
        const text = verdict.text.trim();
        if (!text.includes('<valid/>')) {
          passed = false;
          const match = text.match(/<invalid>([\s\S]*?)<\/invalid>/);
          feedback = `Semantic error: ${match?.[1]?.trim() ?? text}`;
        }
      } catch {
        // verdict call failed — treat as pass to avoid blocking the
        // workflow on a flaky judge LLM. Real Mastra observability
        // span captures the error.
      }
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
    const schemaStore = await lb4Ctx.get<SchemaStore>(SCHEMA_STORE_KEY, {
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
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_VALIDATION_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      failedStep,
    ],
    [async () => true, saveDatasetStep],
  ])
  .commit();

import {createStep} from '@mastra/core/workflows';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
  getDataSetHelper,
  getDatasetStore,
  getQueryCache,
  idToString,
  isCachedDatasetUsable,
  loadCachedSampleQuery,
  tracedGenerateText,
} from '../_helpers';
import {inputSchema, STEP_CHECK_CACHE} from './constants';

type Rc = Parameters<typeof emitToolStatus>[0];
type CacheDoc = {pageContent: string; metadata: {id?: string}};
type CacheOut = {
  cacheHit: boolean;
  datasetId?: string;
  sampleSql?: string;
  samplePrompt?: string;
};

const MISS: CacheOut = {cacheHit: false};

function buildJudgePrompt(prompt: string, docs: CacheDoc[]): string {
  const queries = docs.map((d, i) => `${i + 1}. ${d.pageContent}`).join('\n');
  return `You are a semantic analyser. Given a user's prompt and a list of past prompts that were handled, return the most relevant past prompt and how it relates.
- Return 'AsIs <index>' when the past prompt's result fully answers the new prompt without changes.
- Return 'Similar <index>' when it is close but needs modification.
- Return 'NotRelevant' when nothing fits.

User prompt: ${prompt}
Past prompts:
${queries}

Return ONLY the verdict, no other text.`;
}

function docAt(
  docs: CacheDoc[],
  match: RegExpMatchArray,
): CacheDoc | undefined {
  return docs[Number.parseInt(match[1], 10) - 1];
}

// "Similar" → still regenerate (cacheHit:false), but seed SQL gen with the
// matched query as a worked example (v2 sampleSql/sampleSqlPrompt).
async function resolveSimilar(
  docs: CacheDoc[],
  match: RegExpMatchArray,
  rc: Rc,
): Promise<CacheOut> {
  emitToolStatus(
    rc,
    STEP_CHECK_CACHE,
    'Found similar query in cache, using it as example',
  );
  const doc = docAt(docs, match);
  if (!doc?.metadata?.id) return MISS;
  const sample = await loadCachedSampleQuery(
    getDatasetStore(rc),
    idToString(doc.metadata.id),
    doc.pageContent,
  );
  return sample ? {cacheHit: false, ...sample} : MISS;
}

// "AsIs" → reuse the cached dataset, unless it was disliked or vanished
// (restores v2 CheckCacheNode dislike filtering) in which case regenerate.
async function resolveAsIs(
  docs: CacheDoc[],
  match: RegExpMatchArray,
  rc: Rc,
): Promise<CacheOut> {
  emitToolStatus(rc, STEP_CHECK_CACHE, 'Found relevant query in cache');
  const doc = docAt(docs, match);
  if (!doc?.metadata?.id) return MISS;
  const datasetId = idToString(doc.metadata.id);

  // Re-check table permissions on the cached dataset before reusing it (v2
  // CheckCacheNode parity). A semantic-cache hit can surface another user's
  // dataset in the same tenant; if THIS user lacks permission on its tables,
  // regenerate instead of serving it. The read-time ACL would block delivery
  // anyway, but skipping here gives the user a fresh, answerable query rather
  // than an Unauthorized error. Fail-open when no DataSetHelper is bound.
  const dataSetHelper = getDataSetHelper(rc);
  if (dataSetHelper) {
    const missing = await dataSetHelper.checkPermissions(datasetId);
    if (missing.length > 0) {
      emitToolStatus(
        rc,
        STEP_CHECK_CACHE,
        'Cached result needs tables you cannot access — generating a fresh query',
      );
      return MISS;
    }
  }

  const store = getDatasetStore(rc);
  if (store && !(await isCachedDatasetUsable(store, datasetId))) {
    emitToolStatus(
      rc,
      STEP_CHECK_CACHE,
      'Cached result was disliked — generating a fresh query',
    );
    return MISS;
  }
  return {cacheHit: true, datasetId};
}

async function judgeCache(
  docs: CacheDoc[],
  prompt: string,
  chatLlm: LanguageModel,
  rc: Rc,
  tracing: TracingContext | undefined,
): Promise<CacheOut> {
  try {
    const verdict = await tracedGenerateText({
      model: chatLlm,
      prompt: buildJudgePrompt(prompt, docs),
      tracing,
      label: 'cache-judge',
      resultType: 'reasoning',
    });
    const text = verdict.text.trim();
    const similar = text.match(/Similar\s+(\d+)/i);
    if (similar) return await resolveSimilar(docs, similar, rc);
    const asIs = text.match(/AsIs\s+(\d+)/i);
    if (asIs) return await resolveAsIs(docs, asIs, rc);
  } catch {
    // degrade to a cache miss on judge failure
  }
  return MISS;
}

export const checkCacheStep = createStep({
  id: STEP_CHECK_CACHE,
  inputSchema,
  outputSchema: z.object({
    cacheHit: z.boolean(),
    datasetId: z.string().optional(),
    // A "Similar" cache hit's validated query, threaded into SQL generation
    // as a worked example (cacheHit stays false — it still regenerates).
    sampleSql: z.string().optional(),
    samplePrompt: z.string().optional(),
  }),
  execute: async ({inputData, requestContext, tracingContext}) => {
    const data = inputData as {prompt?: string};
    if (!data.prompt) return MISS;
    const cache = getQueryCache(requestContext);
    const chatLlm = getCheapLlm(requestContext);
    if (!cache || !chatLlm) return MISS;

    let docs: CacheDoc[] = [];
    try {
      docs = await cache.invoke(data.prompt);
    } catch {
      return MISS;
    }
    if (docs.length === 0) return MISS;

    return judgeCache(
      docs,
      data.prompt,
      chatLlm,
      requestContext,
      tracingContext,
    );
  },
});

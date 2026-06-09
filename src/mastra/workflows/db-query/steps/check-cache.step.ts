import {createStep} from '@mastra/core/workflows';
import {z} from 'zod';
import {
  emitToolStatus,
  getCheapLlm,
  getDatasetStore,
  getQueryCache,
  idToString,
  isCachedDatasetUsable,
  loadCachedSampleQuery,
  tracedGenerateText,
} from '../_helpers';
import {inputSchema, STEP_CHECK_CACHE} from './constants';

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
    if (!data.prompt) return {cacheHit: false};
    const cache = getQueryCache(requestContext);
    const chatLlm = getCheapLlm(requestContext);
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
      const verdict = await tracedGenerateText({
        model: chatLlm,
        prompt: judgePrompt,
        tracing: tracingContext,
        label: 'cache-judge',
        resultType: 'reasoning',
      });

      const text = verdict.text.trim();
      const similar = text.match(/Similar\s+(\d+)/i);
      if (similar) {
        emitToolStatus(
          requestContext,
          STEP_CHECK_CACHE,
          'Found similar query in cache, using it as example',
        );
        // Seed SQL generation with the similar query as a worked example
        // (v2 sampleSql) — still regenerates (cacheHit:false), just informed.
        const doc = docs[parseInt(similar[1], 10) - 1];
        const sample = doc?.metadata?.id
          ? await loadCachedSampleQuery(
              getDatasetStore(requestContext),
              idToString(doc.metadata.id),
              doc.pageContent,
            )
          : undefined;
        return sample ? {cacheHit: false, ...sample} : {cacheHit: false};
      }

      const match = text.match(/AsIs\s+(\d+)/i);
      if (match) {
        emitToolStatus(
          requestContext,
          STEP_CHECK_CACHE,
          'Found relevant query in cache',
        );
        const idx = parseInt(match[1], 10) - 1;
        const doc = docs[idx];
        if (doc?.metadata?.id) {
          const datasetId = idToString(doc.metadata.id);
          // Don't re-serve a disliked or vanished dataset — regenerate
          // instead (restores v2 CheckCacheNode dislike filtering).
          const store = getDatasetStore(requestContext);
          if (store && !(await isCachedDatasetUsable(store, datasetId))) {
            emitToolStatus(
              requestContext,
              STEP_CHECK_CACHE,
              'Cached result was disliked — generating a fresh query',
            );
            return {cacheHit: false};
          }
          return {cacheHit: true, datasetId};
        }
      }
    } catch {
      // degrade to miss on judge failure
    }

    return {cacheHit: false};
  },
});

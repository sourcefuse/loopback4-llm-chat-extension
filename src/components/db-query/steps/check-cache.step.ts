import {inject} from '@loopback/core';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DataSetHelper} from '../services';
import {emitToolStatus, idToString, tracedGenerateText} from './_helpers';
import {STEP_CHECK_CACHE} from './constants';

type Rc = Parameters<typeof emitToolStatus>[0];
type CacheDoc = {pageContent: string; metadata: {id?: string}};
type CacheCollaborators = {
  dataSetHelper?: DataSetHelper;
};
type QueryCache = {
  invoke(input: string): Promise<Array<CacheDoc>>;
};
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
  collaborators: CacheCollaborators,
): Promise<CacheOut> {
  emitToolStatus(
    rc,
    STEP_CHECK_CACHE,
    'Found similar query in cache, using it as example',
  );
  const doc = docAt(docs, match);
  if (!doc?.metadata?.id) return MISS;
  const sample = await collaborators.dataSetHelper?.loadSampleQuery(
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
  collaborators: CacheCollaborators,
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
  const dataSetHelper = collaborators.dataSetHelper;
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
    if (!(await dataSetHelper.isCachedDatasetUsable(datasetId))) {
      emitToolStatus(
        rc,
        STEP_CHECK_CACHE,
        'Cached result was disliked — generating a fresh query',
      );
      return MISS;
    }
  }
  return {cacheHit: true, datasetId};
}

async function judgeCache(
  docs: CacheDoc[],
  prompt: string,
  chatLlm: LanguageModel,
  rc: Rc,
  tracing: TracingContext | undefined,
  collaborators: CacheCollaborators,
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
    if (similar) return await resolveSimilar(docs, similar, rc, collaborators);
    const asIs = text.match(/AsIs\s+(\d+)/i);
    if (asIs) return await resolveAsIs(docs, asIs, rc, collaborators);
  } catch {
    // degrade to a cache miss on judge failure
  }
  return MISS;
}

/**
 * Semantic-cache gate (the Mastra-named successor of the LangGraph
 * CheckCacheNode). DI-resolved `@step` class with constructor-injected
 * collaborators (query cache, dataset store, dataset helper, cheap LLM tier).
 */
@step(STEP_CHECK_CACHE)
export class CheckCacheStep implements IWorkflowStep<
  {prompt?: string},
  CacheOut
> {
  constructor(
    @inject(DbQueryAIExtensionBindings.QueryCache, {optional: true})
    private readonly queryCache?: QueryCache,
    @inject('services.DataSetHelper', {optional: true})
    private readonly dataSetHelper?: DataSetHelper,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    private readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    private readonly cheapModel?: LanguageModel,
  ) {}

  async execute({
    inputData,
    requestContext,
    tracingContext,
  }: WorkflowStepCtx<{prompt?: string}>): Promise<CacheOut> {
    const data = inputData;
    if (!data.prompt) return MISS;
    const cache = this.queryCache;
    const chatLlm = this.cheapModel ?? this.chatModel;
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
      {dataSetHelper: this.dataSetHelper},
    );
  }
}

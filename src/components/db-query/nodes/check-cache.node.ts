import {inject} from '@loopback/core';
import type {TracingContext} from '@mastra/core/observability';
import type {LanguageModel} from 'ai';
import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import type {DataSetHelper} from '../services';
import type {CacheDoc, CacheOut, QueryCache} from '../types';
import {
  emitToolStatus,
  idToString,
  tracedGenerateText,
  type Rc,
} from '../_helpers';
import {DbQueryNodes} from '../nodes.enum';

const MISS: CacheOut = {cacheHit: false};

/**
 * Semantic-cache gate (the successor of the LangGraph CheckCacheNode). A
 * DI-resolved `@graphNode` class with constructor-injected collaborators (query
 * cache, dataset helper, cheap LLM tier).
 *
 * All the judge/resolve logic lives on the class as `protected` methods so a
 * host app can `extends CheckCacheNode` and override a single step (e.g. swap
 * the judge prompt or the AsIs reuse rules) without rewriting `execute`, then
 * rebind its subclass with `@graphNode(DbQueryNodes.CheckCache)`.
 */
@graphNode(DbQueryNodes.CheckCache)
export class CheckCacheNode implements IGraphNode<{prompt?: string}, CacheOut> {
  constructor(
    @inject(DbQueryAIExtensionBindings.QueryCache, {optional: true})
    protected readonly queryCache?: QueryCache,
    @inject('services.DataSetHelper', {optional: true})
    protected readonly dataSetHelper?: DataSetHelper,
    @inject(AiIntegrationBindings.ChatModel, {optional: true})
    protected readonly chatModel?: LanguageModel,
    @inject(AiIntegrationBindings.CheapModel, {optional: true})
    protected readonly cheapModel?: LanguageModel,
  ) {}

  async execute({
    inputData,
    requestContext,
    tracingContext,
  }: GraphNodeCtx<{prompt?: string}>): Promise<CacheOut> {
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

    return this.judgeCache(
      docs,
      data.prompt,
      chatLlm,
      requestContext,
      tracingContext,
    );
  }

  protected buildJudgePrompt(prompt: string, docs: CacheDoc[]): string {
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

  protected docAt(
    docs: CacheDoc[],
    match: RegExpMatchArray,
  ): CacheDoc | undefined {
    return docs[Number.parseInt(match[1], 10) - 1];
  }

  // "Similar" → still regenerate (cacheHit:false), but seed SQL gen with the
  // matched query as a worked example (v2 sampleSql/sampleSqlPrompt).
  protected async resolveSimilar(
    docs: CacheDoc[],
    match: RegExpMatchArray,
    rc: Rc,
  ): Promise<CacheOut> {
    emitToolStatus(
      rc,
      DbQueryNodes.CheckCache,
      'Found similar query in cache, using it as example',
    );
    const doc = this.docAt(docs, match);
    if (!doc?.metadata?.id) return MISS;
    const sample = await this.dataSetHelper?.loadSampleQuery(
      idToString(doc.metadata.id),
      doc.pageContent,
    );
    return sample ? {cacheHit: false, ...sample} : MISS;
  }

  // "AsIs" → reuse the cached dataset, unless it was disliked or vanished
  // (restores v2 CheckCacheNode dislike filtering) in which case regenerate.
  protected async resolveAsIs(
    docs: CacheDoc[],
    match: RegExpMatchArray,
    rc: Rc,
  ): Promise<CacheOut> {
    emitToolStatus(
      rc,
      DbQueryNodes.CheckCache,
      'Found relevant query in cache',
    );
    const doc = this.docAt(docs, match);
    if (!doc?.metadata?.id) return MISS;
    const datasetId = idToString(doc.metadata.id);

    // Re-check table permissions on the cached dataset before reusing it (v2
    // CheckCacheNode parity). A semantic-cache hit can surface another user's
    // dataset in the same tenant; if THIS user lacks permission on its tables,
    // regenerate instead of serving it. The read-time ACL would block delivery
    // anyway, but skipping here gives the user a fresh, answerable query rather
    // than an Unauthorized error. Fail-open when no DataSetHelper is bound.
    const dataSetHelper = this.dataSetHelper;
    if (dataSetHelper) {
      const missing = await dataSetHelper.checkPermissions(datasetId);
      if (missing.length > 0) {
        emitToolStatus(
          rc,
          DbQueryNodes.CheckCache,
          'Cached result needs tables you cannot access — generating a fresh query',
        );
        return MISS;
      }
      if (!(await dataSetHelper.isCachedDatasetUsable(datasetId))) {
        emitToolStatus(
          rc,
          DbQueryNodes.CheckCache,
          'Cached result was disliked — generating a fresh query',
        );
        return MISS;
      }
    }
    return {cacheHit: true, datasetId};
  }

  protected async judgeCache(
    docs: CacheDoc[],
    prompt: string,
    chatLlm: LanguageModel,
    rc: Rc,
    tracing: TracingContext | undefined,
  ): Promise<CacheOut> {
    try {
      const verdict = await tracedGenerateText({
        model: chatLlm,
        prompt: this.buildJudgePrompt(prompt, docs),
        tracing,
        label: 'cache-judge',
        resultType: 'reasoning',
      });
      const text = verdict.text.trim();
      const similar = text.match(/Similar\s+(\d+)/i);
      if (similar) return await this.resolveSimilar(docs, similar, rc);
      const asIs = text.match(/AsIs\s+(\d+)/i);
      if (asIs) return await this.resolveAsIs(docs, asIs, rc);
    } catch {
      // degrade to a cache miss on judge failure
    }
    return MISS;
  }
}

import {graphNode} from '../../../decorators';
import type {IGraphNode, GraphNodeCtx} from '../../../graphs/types';
import {classifyPostCacheStatus} from '../constants';
import {DbQueryNodes} from '../nodes.enum';

/**
 * Fan-in classifier after the parallel cache / tables / templates branch (the
 * Mastra-named successor of the LangGraph PostCacheAndTables routing node).
 * Reads the three upstream step results via Mastra's `getStepResult` — the
 * full execute context is forwarded by the shell precisely so fan-in steps
 * keep working.
 */
@graphNode(DbQueryNodes.PostCacheAndTables)
export class PostCacheAndTablesNode implements IGraphNode {
  async execute({getStepResult, getInitData, inputData}: GraphNodeCtx) {
    const cache = (getStepResult(DbQueryNodes.CheckCache) ?? {
      cacheHit: false,
    }) as {
      cacheHit: boolean;
      datasetId?: string;
      sampleSql?: string;
      samplePrompt?: string;
    };
    const tables = (getStepResult(DbQueryNodes.GetTables) ?? {tables: []}) as {
      tables: string[];
    };
    const templates = (getStepResult(DbQueryNodes.CheckTemplates) ?? {
      matched: false,
    }) as {matched: boolean; templateId?: string};

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
      sampleSql: cache.sampleSql,
      samplePrompt: cache.samplePrompt,
    };
  }
}

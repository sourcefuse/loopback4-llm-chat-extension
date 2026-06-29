import {step} from '../../../decorators';
import type {IWorkflowStep, WorkflowStepCtx} from '../../../graphs/types';
import {
  classifyPostCacheStatus,
  STEP_CHECK_CACHE,
  STEP_CHECK_TEMPLATES,
  STEP_GET_TABLES,
  STEP_POST_CACHE_AND_TABLES,
} from './constants';

/**
 * Fan-in classifier after the parallel cache / tables / templates branch (the
 * Mastra-named successor of the LangGraph PostCacheAndTables routing node).
 * Reads the three upstream step results via Mastra's `getStepResult` — the
 * full execute context is forwarded by the shell precisely so fan-in steps
 * keep working.
 */
@step(STEP_POST_CACHE_AND_TABLES)
export class PostCacheAndTablesStep implements IWorkflowStep {
  async execute({getStepResult, getInitData, inputData}: WorkflowStepCtx) {
    const cache = (getStepResult(STEP_CHECK_CACHE) ?? {cacheHit: false}) as {
      cacheHit: boolean;
      datasetId?: string;
      sampleSql?: string;
      samplePrompt?: string;
    };
    const tables = (getStepResult(STEP_GET_TABLES) ?? {tables: []}) as {
      tables: string[];
    };
    const templates = (getStepResult(STEP_CHECK_TEMPLATES) ?? {
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

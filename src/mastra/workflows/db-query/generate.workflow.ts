import {createWorkflow} from '@mastra/core/workflows';
import {
  MAX_VALIDATION_ATTEMPTS,
  inputSchema,
  outputSchema,
  checkCacheStep,
  getTablesStep,
  checkTemplatesStep,
  postCacheAndTablesStep,
  saveDatasetFromTemplateStep,
  returnCachedStep,
  failedStep,
  getColumnsStep,
  generateChecklistStep,
  sqlAndValidateStep,
  saveDatasetStep,
} from './generate.steps';

/**
 * generateQueryWorkflow — NL → SQL → dataset. Topology only; every step
 * body lives in `generate.steps.ts` so this file reads as the DAG.
 *
 * Flow: parallel(cache / tables / templates) → classify → branch
 *   - FromTemplate → save-from-template (terminal)
 *   - AsIs (cache hit) → return-cached (terminal)
 *   - Failed → failed (terminal)
 *   - Continue → get-columns → checklist → dountil(sql+validate) →
 *       branch(save-dataset / failed)
 *
 * Cache/template hits short-circuit: the Continue arm carries the only
 * generation pipeline; the other arms are terminal (see generate.steps.ts
 * for the cache passthrough that keeps regeneration from clobbering a hit).
 */
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

import {createWorkflow} from '@mastra/core/workflows';
import {
  MAX_VALIDATION_ATTEMPTS,
  checkCacheStep,
  checkTemplatesStep,
  failedStep,
  generateChecklistStep,
  getColumnsStep,
  getTablesStep,
  inputSchema,
  outputSchema,
  postCacheAndTablesStep,
  returnCachedStep,
  saveDatasetFromTemplateStep,
  saveDatasetStep,
  sqlAndValidateStep,
} from '../steps';

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

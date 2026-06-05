import {createWorkflow} from '@mastra/core/workflows';
import {
  MAX_IMPROVE_ATTEMPTS,
  fixQueryStep,
  improveFailedStep,
  improveInputSchema,
  improveOutputSchema,
  loadExistingStep,
  saveImprovedStep,
} from '../steps';

export const improveQueryWorkflow = createWorkflow({
  id: 'improve-query',
  inputSchema: improveInputSchema,
  outputSchema: improveOutputSchema,
})
  .then(loadExistingStep)
  .dountil(
    fixQueryStep,
    async ({inputData}) =>
      inputData.passed || inputData.attempts >= MAX_IMPROVE_ATTEMPTS,
  )
  .branch([
    [
      async ({inputData}) => !(inputData as {passed?: boolean}).passed,
      improveFailedStep,
    ],
    [
      async ({inputData}) => (inputData as {passed?: boolean}).passed === true,
      saveImprovedStep,
    ],
  ])
  .commit();

import {createWorkflow} from '@mastra/core/workflows';
import {
  callQueryGenerationStep,
  getDatasetDataStep,
  renderVisualizationStep,
  selectVisualisationStep,
  visualizationInputSchema,
  visualizationOutputSchema,
} from '../steps';

export const visualizationWorkflow = createWorkflow({
  id: 'visualization',
  inputSchema: visualizationInputSchema,
  outputSchema: visualizationOutputSchema,
})
  .then(selectVisualisationStep)
  .then(callQueryGenerationStep)
  .then(getDatasetDataStep)
  .then(renderVisualizationStep)
  .commit();

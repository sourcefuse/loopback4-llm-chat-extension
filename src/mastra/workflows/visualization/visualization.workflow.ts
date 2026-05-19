import {createWorkflow} from '@mastra/core/workflows';
import {
  visualizationWorkflowInputSchema,
  visualizationWorkflowOutputSchema,
} from './visualization-workflow-schemas';
import {
  visualizationSelectionStep,
  queryGenerationStep,
  dataFetchStep,
  renderConfigStep,
} from './steps';

/**
 * VisualizationWorkflow — Mastra replacement for the LangGraph VisualizationGraph.
 *
 * Step pipeline:
 *  visualization-selection → query-generation → data-fetch → render-config
 */
export const visualizationWorkflow = createWorkflow({
  id: 'visualization-workflow',
  inputSchema: visualizationWorkflowInputSchema,
  outputSchema: visualizationWorkflowOutputSchema,
})
  .then(visualizationSelectionStep)
  .then(queryGenerationStep)
  .then(dataFetchStep)
  .then(renderConfigStep)
  .commit();

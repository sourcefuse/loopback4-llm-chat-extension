// DI-backed visualization workflow step implementations (the Mastra-named
// successors of the LangGraph visualization `nodes/`). Each is an
// `@step(key)`-decorated injectable resolved by tag at run time; the Mastra
// visualizationWorkflow references only the key via a committed shell.
import type {IWorkflowStep, StepResolver} from '../../../graphs/types';
import {
  STEP_CALL_QUERY_GENERATION,
  STEP_GET_DATASET_DATA,
  STEP_RENDER_VISUALIZATION,
  STEP_SELECT_VISUALISATION,
} from './shared';

import {CallQueryGenerationStep} from './call-query-generation.step';
import {GetDatasetDataStep} from './get-dataset-data.step';
import {RenderVisualizationStep} from './render-visualization.step';
import {SelectVisualisationStep} from './select-visualisation.step';

export {CallQueryGenerationStep} from './call-query-generation.step';
export {GetDatasetDataStep} from './get-dataset-data.step';
export {RenderVisualizationStep} from './render-visualization.step';
export {SelectVisualisationStep} from './select-visualisation.step';

/** Every visualization workflow step class — spread into VisualizerComponent.services. */
export const VISUALIZATION_STEP_CLASSES: Array<new () => IWorkflowStep> = [
  SelectVisualisationStep,
  CallQueryGenerationStep,
  GetDatasetDataStep,
  RenderVisualizationStep,
];

/**
 * resolverKey → step class. Production resolves from the container
 * (WorkflowRunner.resolveWorkflowStep); this static map is a test convenience
 * (see {@link makeStaticStepResolver}) for running the workflow without a boot.
 */
export const VISUALIZATION_STEP_BY_KEY: Record<
  string,
  new () => IWorkflowStep
> = {
  [STEP_SELECT_VISUALISATION]: SelectVisualisationStep,
  [STEP_CALL_QUERY_GENERATION]: CallQueryGenerationStep,
  [STEP_GET_DATASET_DATA]: GetDatasetDataStep,
  [STEP_RENDER_VISUALIZATION]: RenderVisualizationStep,
};

/**
 * Build a {@link StepResolver} backed by {@link VISUALIZATION_STEP_BY_KEY} for
 * tests that run the visualization workflow without the LB4 container. NOT used
 * in production.
 */
export function makeStaticStepResolver(): StepResolver {
  return async (key: string) => {
    const ctor = VISUALIZATION_STEP_BY_KEY[key];
    if (!ctor)
      throw new Error(`No visualization step registered for key "${key}"`);
    return new ctor();
  };
}

import {createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';
import {BaseGraph, passthroughSchema} from '../../graphs';
import {
  VisualizationGraphState,
  VisualizationGraphStateAnnotation,
} from './state';
import {VisualizationGraphNodes} from './nodes.enum';

export class VisualizationGraph extends BaseGraph<VisualizationGraphState> {
  protected stateSchema =
    VisualizationGraphStateAnnotation as unknown as z.ZodType<VisualizationGraphState>;

  build() {
    const selectVisualisation = this._toStep(
      VisualizationGraphNodes.SelectVisualisation,
    );
    const callQueryGeneration = this._toStep(
      VisualizationGraphNodes.CallQueryGeneration,
    );
    const getDatasetData = this._toStep(VisualizationGraphNodes.GetDatasetData);
    const renderVisualization = this._toStep(
      VisualizationGraphNodes.RenderVisualization,
    );
    const noop = this._toFnStep('visualization_noop', () => ({}));

    // GetDatasetData → RenderVisualization (the success tail).
    const renderFlow = createWorkflow({
      id: 'visualization_render_flow',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(getDatasetData)
      .then(renderVisualization)
      .commit();

    // CallQueryGeneration → (error ? END : render tail).
    const queryFlow = createWorkflow({
      id: 'visualization_query_flow',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(callQueryGeneration)
      .branch([
        [async ({state}) => !!(state as VisualizationGraphState).error, noop],
        [
          async ({state}) => !(state as VisualizationGraphState).error,
          renderFlow,
        ],
      ])
      .commit();

    return createWorkflow({
      id: 'visualization_graph',
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
      stateSchema: this.stateSchema,
    })
      .then(selectVisualisation)
      .branch([
        [async ({state}) => !!(state as VisualizationGraphState).error, noop],
        [
          async ({state}) => !(state as VisualizationGraphState).error,
          queryFlow,
        ],
      ])
      .commit();
  }
}

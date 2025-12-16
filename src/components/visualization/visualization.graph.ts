import {END, START, StateGraph} from '@langchain/langgraph';
import {BaseGraph} from '../../graphs';
import {
  VisualizationGraphState,
  VisualizationGraphStateAnnotation,
} from './state';
import {VisualizationGraphNodes} from './nodes.enum';

export class VisualizationGraph extends BaseGraph<VisualizationGraphState> {
  async build() {
    const graph = new StateGraph(VisualizationGraphStateAnnotation);
    graph
      .addNode(
        VisualizationGraphNodes.CallQueryGeneration,
        await this._getNodeFn(VisualizationGraphNodes.CallQueryGeneration),
      )
      .addNode(
        VisualizationGraphNodes.GetDatasetData,
        await this._getNodeFn(VisualizationGraphNodes.GetDatasetData),
      )
      .addNode(
        VisualizationGraphNodes.SelectVisualisation,
        await this._getNodeFn(VisualizationGraphNodes.SelectVisualisation),
      )
      .addNode(
        VisualizationGraphNodes.RenderVisualization,
        await this._getNodeFn(VisualizationGraphNodes.RenderVisualization),
      )
      .addEdge(START, VisualizationGraphNodes.SelectVisualisation)
      .addConditionalEdges(
        VisualizationGraphNodes.SelectVisualisation,
        state => {
          if (state.error) {
            return 'Error';
          }
          return 'Success';
        },
        {
          Error: END,
          Success: VisualizationGraphNodes.CallQueryGeneration,
        },
      )
      .addConditionalEdges(
        VisualizationGraphNodes.CallQueryGeneration,
        state => {
          if (state.error) {
            return 'Error';
          }
          return 'Success';
        },
        {
          Error: END,
          Success: VisualizationGraphNodes.GetDatasetData,
        },
      )
      .addEdge(
        VisualizationGraphNodes.GetDatasetData,
        VisualizationGraphNodes.RenderVisualization,
      )
      .addEdge(VisualizationGraphNodes.RenderVisualization, END);
    return graph.compile();
  }
}

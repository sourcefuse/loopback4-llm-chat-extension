import {
  Binding,
  Component,
  Constructor,
  ControllerClass,
  LifeCycleObserver,
  ProviderMap,
  ServiceOrProviderClass,
} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {VisualizationGraph} from './visualization.graph';
import {
  GetDatasetDataNode,
  RenderVisualizationNode,
  SelectVisualizationNode,
} from './nodes';
import {GenerateVisualizationTool} from './tools/generate-visualization.tool';
import {PieVisualizer, BarVisualizer, LineVisualizer} from './visualizers';
import {GetVisualizationContextTool} from './tools';

export class VisualizerComponent implements Component {
  services: ServiceOrProviderClass[] | undefined;
  controllers: ControllerClass[] | undefined;
  components: Constructor<Component>[] | undefined;
  providers: ProviderMap | undefined;
  bindings: Binding<AnyObject>[] | undefined;
  lifeCycleObservers: Constructor<LifeCycleObserver>[] | undefined;

  constructor() {
    this.controllers = [];
    this.providers = {};
    this.bindings = [];
    this.lifeCycleObservers = [];
    this.services = [
      // graph
      VisualizationGraph,
      // tools
      GenerateVisualizationTool,
      GetVisualizationContextTool,
      // nodes
      GetDatasetDataNode,
      SelectVisualizationNode,
      RenderVisualizationNode,
      // visualizers
      PieVisualizer,
      BarVisualizer,
      LineVisualizer,
    ];
    this.components = [];
  }
}

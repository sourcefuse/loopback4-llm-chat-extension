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
import {PieVisualizer, BarVisualizer, LineVisualizer} from './visualizers';
import {
  CallQueryGenerationNode,
  GetDatasetDataNode,
  RenderVisualizationNode,
  SelectVisualizationNode,
} from './nodes';
import {GenerateVisualizationTool} from './tools';

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
      // visualizers (consumer-extensible via @visualizer() — the Mastra
      // visualizationWorkflow's render node dispatches to these via
      // RequestContext, see)
      PieVisualizer,
      BarVisualizer,
      LineVisualizer,
      // visualization tool — registered here (not the root component) so it
      // rides with VisualizerComponent. Discovered by tag (@graphTool).
      GenerateVisualizationTool,
      // workflow nodes — registered as tagged services (like the LangGraph
      // version); discovered by `@graphNode(key)` tag and resolved per request.
      SelectVisualizationNode,
      CallQueryGenerationNode,
      GetDatasetDataNode,
      RenderVisualizationNode,
    ];
    this.components = [];
  }
}

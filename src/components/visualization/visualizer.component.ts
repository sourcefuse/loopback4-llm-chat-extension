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
import {GenerateVisualizationTool} from './tools/generate-visualization.tool';
import {
  MastraVisualizationWorkflow,
  MastraBarVisualizerService,
  MastraLineVisualizerService,
  MastraPieVisualizerService,
} from '../../mastra/visualization';

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
      // tools
      GenerateVisualizationTool,

      // ── Mastra path ──────────────────────────────────────────────────────
      // Workflow orchestrator
      MastraVisualizationWorkflow,
      // Visualizer services (use AI SDK generateObject())
      MastraBarVisualizerService,
      MastraLineVisualizerService,
      MastraPieVisualizerService,
    ];
    this.components = [];
  }
}

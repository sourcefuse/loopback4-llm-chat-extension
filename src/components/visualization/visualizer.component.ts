import {
  Binding,
  Component,
  Constructor,
  ControllerClass,
  createBindingFromClass,
  LifeCycleObserver,
  ProviderMap,
  ServiceOrProviderClass,
} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {STEP_DEFAULT} from '../../constant';
import {PieVisualizer, BarVisualizer, LineVisualizer} from './visualizers';
import {VISUALIZATION_STEP_CLASSES} from './steps';
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
    // DI-backed visualization workflow steps — bound as tagged services (the
    // `@step(key)` tag makes them discoverable) and marked STEP_DEFAULT so a
    // host override (a second `@step(key)` binding) is preferred by the resolver.
    this.bindings = VISUALIZATION_STEP_CLASSES.map(stepClass =>
      createBindingFromClass(stepClass).tag({[STEP_DEFAULT]: true}),
    );
    this.lifeCycleObservers = [];
    this.services = [
      // visualizers (consumer-extensible via @visualizer() — the Mastra
      // visualizationWorkflow's render step dispatches to these via
      // RequestContext, see)
      PieVisualizer,
      BarVisualizer,
      LineVisualizer,
      // visualization tool — registered here (not the root component) so it
      // rides with VisualizerComponent. Discovered by tag (@graphTool).
      GenerateVisualizationTool,
    ];
    this.components = [];
  }
}

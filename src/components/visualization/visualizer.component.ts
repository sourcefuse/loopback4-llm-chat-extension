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
      // native visualizers
      PieVisualizer,
      BarVisualizer,
      LineVisualizer,
    ];
    this.components = [];
  }
}

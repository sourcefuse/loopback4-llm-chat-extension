import {AnyObject} from '@loopback/repository';
import {VisualizationGraphState} from './state';

export interface IVisualizer {
  name: string;
  description: string;
  context?: string;
  getConfig(state: VisualizationGraphState): Promise<AnyObject> | AnyObject;
}

export type VisualizerStore = {
  list: IVisualizer[];
  map: Record<string, IVisualizer>;
};

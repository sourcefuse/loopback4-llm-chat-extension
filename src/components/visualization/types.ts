import {AnyObject} from '@loopback/repository';
import {VisualizationGraphState} from './state';

export interface IVisualizer {
  name: string;
  description: string;
  getConfig(state: VisualizationGraphState): Promise<AnyObject> | AnyObject;
}

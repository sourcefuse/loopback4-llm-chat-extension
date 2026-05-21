import {AnyObject} from '@loopback/repository';
import type {RequestContext} from '@mastra/core/request-context';

export type VisualizationConfigInput = {
  prompt?: string;
  datasetId?: string;
  sql?: string;
  queryDescription?: string;
  visualizerName?: string;
  type?: string;
};

export type VisualizationConfigOptions = {
  requestContext?: RequestContext;
};

export interface IVisualizer {
  name: string;
  description: string;
  context?: string;
  getConfig(
    input: VisualizationConfigInput,
    options?: VisualizationConfigOptions,
  ): Promise<AnyObject> | AnyObject;
}

export type VisualizerStore = {
  list: IVisualizer[];
  map: Record<string, IVisualizer>;
};

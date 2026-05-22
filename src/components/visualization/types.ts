import {AnyObject} from '@loopback/repository';

/**
 * Plain interface describing what a visualizer needs to render a chart.
 * Lifted out of the deleted state.ts (formerly a LangGraph Annotation)
 * so visualizers stay framework-free. The Mastra visualizationWorkflow
 * (Section 9.3) populates this shape from RequestContext at runtime.
 */
export interface VisualizationGraphState {
  prompt: string;
  datasetId: string;
  sql?: string;
  queryDescription?: string;
  visualizer?: IVisualizer;
  visualizerName?: string;
  done?: boolean;
  visualizerConfig?: AnyObject;
  error?: string;
  type?: string;
}

export interface IVisualizer {
  name: string;
  description: string;
  context?: string;
  getConfig(state: VisualizationGraphState): Promise<AnyObject> | AnyObject;
}

import {AnyObject} from '@loopback/repository';

// ---------------------------------------------------------------------------
// Visualization workflow node I/O types — kept here (not inline in the
// `nodes/*.node.ts` files) to match the LangGraph structure.
// ---------------------------------------------------------------------------

/** SelectVisualizationNode input. */
export type SelectIn = {datasetId: string; userQuery: string; type?: string};
/** CallQueryGenerationNode input. */
export type CallQueryIn = {
  datasetId: string;
  needsQuery: boolean;
  chartType: string;
  userQuery: string;
  rejected?: boolean;
  reason?: string;
};
/** RenderVisualizationNode input. */
export type RenderIn = {
  datasetId: string;
  rows: unknown[];
  chartType: string;
  userQuery: string;
  sql?: string;
  description?: string;
  rejected?: boolean;
  reason?: string;
};

/**
 * Plain interface describing what a visualizer needs to render a chart.
 * Lifted out of the deleted state.ts (formerly a LangGraph Annotation)
 * so visualizers stay framework-free. The Mastra visualizationWorkflow
 * populates this shape from RequestContext at runtime.
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

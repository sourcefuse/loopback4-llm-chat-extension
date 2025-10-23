import {Annotation} from '@langchain/langgraph';
import {IVisualizer} from './types';
import {AnyObject} from '@loopback/repository';

export const VisualizationGraphStateAnnotation = Annotation.Root({
  prompt: Annotation<string>,
  datasetId: Annotation<string>,
  sql: Annotation<string | undefined>,
  queryDescription: Annotation<string | undefined>,
  visualizer: Annotation<IVisualizer | undefined>,
  visualizerName: Annotation<string | undefined>,
  done: Annotation<boolean | undefined>,
  visualizerConfig: Annotation<AnyObject | undefined>,
  error: Annotation<string | undefined>,
  type: Annotation<string | undefined>,
});

export type VisualizationGraphState =
  typeof VisualizationGraphStateAnnotation.State;

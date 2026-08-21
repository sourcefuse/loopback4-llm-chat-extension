import {z} from 'zod';
import {IVisualizer} from './types';
import {AnyObject} from '@loopback/repository';

/**
 * Permissive zod schema used as the Mastra workflow `stateSchema`. All fields
 * optional (so partial/initial states validate) with `catchall` to never strip.
 * `VisualizationGraphState` below preserves the exact shape the nodes rely on.
 */
export const VisualizationGraphStateAnnotation = z
  .object({
    prompt: z.string().optional(),
    datasetId: z.string().optional(),
    sql: z.string().optional(),
    queryDescription: z.string().optional(),
    visualizer: z.custom<IVisualizer>().optional(),
    visualizerName: z.string().optional(),
    done: z.boolean().optional(),
    visualizerConfig: z.custom<AnyObject>().optional(),
    error: z.string().optional(),
    type: z.string().optional(),
  })
  .catchall(z.any());

export type VisualizationGraphState = {
  prompt: string;
  datasetId: string;
  sql: string | undefined;
  queryDescription: string | undefined;
  visualizer: IVisualizer | undefined;
  visualizerName: string | undefined;
  done: boolean | undefined;
  visualizerConfig: AnyObject | undefined;
  error: string | undefined;
  type: string | undefined;
};

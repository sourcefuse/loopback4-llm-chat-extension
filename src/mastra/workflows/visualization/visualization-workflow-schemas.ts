import {z} from 'zod';

const looseObjectSchema = z.object({}).passthrough();

export const visualizationWorkflowInputSchema = z.object({
  prompt: z
    .string()
    .describe(
      'Prompt from the user that will be used for generating the visualization.',
    ),
  datasetId: z
    .string()
    .optional()
    .describe(
      "ID of the dataset that needs to be visualized. Use the dataset ID from 'get-data-as-dataset' or 'improve-dataset' if available.",
    ),
  type: z
    .string()
    .optional()
    .describe(
      'Type of visualization to be generated. If not provided, the system will decide the best visualization based on the prompt.',
    ),
});

export type VisualizationWorkflowInput = z.infer<
  typeof visualizationWorkflowInputSchema
>;

export const visualizationWorkflowStateSchema =
  visualizationWorkflowInputSchema.extend({
    visualizerName: z.string().optional(),
    visualizerContext: z.string().optional(),
    sql: z.string().optional(),
    queryDescription: z.string().optional(),
    visualizerConfig: looseObjectSchema.optional(),
    done: z.boolean().optional(),
    error: z.string().optional(),
  });

export type VisualizationWorkflowState = z.infer<
  typeof visualizationWorkflowStateSchema
>;

export const visualizationWorkflowOutputSchema = z.object({
  datasetId: z.string().optional(),
  visualizerName: z.string().optional(),
  visualizerConfig: looseObjectSchema.optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});

export type VisualizationWorkflowOutput = z.infer<
  typeof visualizationWorkflowOutputSchema
>;

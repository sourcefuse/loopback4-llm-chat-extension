import {Context, inject, service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool, IRuntimeTool, ToolStatus} from '../../../graphs';
import {VisualizationGraph} from '../visualization.graph';
import {VISUALIZATION_KEY} from '../keys';
import {IVisualizer} from '../types';

@graphTool({
  description: `Generates a visualization for the user's request. It takes in a prompt and an optional dataset ID.
If the user's request involves trends, growth, decline, comparisons, distributions, patterns, correlations, or any analytical insight, ALWAYS use this tool instead of 'get-data-as-dataset'.
No need to call 'get-data-as-dataset' tool before this — if the dataset ID is not provided, this tool will internally fetch the data to be visualized.
It does not return anything, instead it fires an event internally that renders the visualization on the UI for the user to see.`,
  inputSchema: z.object({
    prompt: z
      .string()
      .describe(
        `Prompt from the user that will be used for generating the visualization.`,
      ),
    datasetId: z
      .string()
      .optional()
      .describe(
        `ID of the dataset that needs to be visualized. Use the dataset ID from 'get-data-as-dataset' or 'improve-dataset' tool if available. If not provided, the tool will internally fetch the data.`,
      ),
    type: z
      .string()
      .optional()
      .describe(
        `Type of visualization to be generated (e.g. bar, line, pie). If not provided, the system will decide the best visualization based on the data and prompt.`,
      ),
  }),
})
export class GenerateVisualizationTool implements IGraphTool {
  needsReview = false;
  key = 'generate-visualization';
  // Note: the `type` field enum values are populated dynamically from available
  // visualizer bindings at request time.  The static schema here omits the enum
  // constraint so the Mastra agent can be registered without resolving the
  // full visualization graph at startup.
  description = `Generates a visualization for the user's request. It takes in a prompt and an optional dataset ID.
If the user's request involves trends, growth, decline, comparisons, distributions, patterns, correlations, or any analytical insight, ALWAYS use this tool instead of 'get-data-as-dataset'.
No need to call 'get-data-as-dataset' tool before this — if the dataset ID is not provided, this tool will internally fetch the data to be visualized.
It does not return anything, instead it fires an event internally that renders the visualization on the UI for the user to see.`;
  inputSchema = z.object({
    prompt: z
      .string()
      .describe(
        `Prompt from the user that will be used for generating the visualization.`,
      ),
    datasetId: z
      .string()
      .optional()
      .describe(
        `ID of the dataset that needs to be visualized. Use the dataset ID from 'get-data-as-dataset' or 'improve-dataset' tool if available. If not provided, the tool will internally fetch the data.`,
      ),
    type: z
      .string()
      .optional()
      .describe(
        `Type of visualization to be generated (e.g. bar, line, pie). If not provided, the system will decide the best visualization based on the data and prompt.`,
      ),
  });
  constructor(
    @service(VisualizationGraph)
    private readonly visualizationGraph: VisualizationGraph,
    @inject.context()
    private readonly context: Context,
  ) {}

  getValue(result: Record<string, string>): string {
    if (result.error) {
      return `Visualization could not be generated. Reason: ${result.error}`;
    }
    return `Visualization rendered for the user with the following config: ${JSON.stringify(
      result.visualizerConfig,
      undefined,
      2,
    )}`;
  }

  getMetadata(result: Record<string, string>): AnyObject {
    return {
      status: result.done ? ToolStatus.Completed : ToolStatus.Failed,
      existingDatasetId: result.datasetId,
      config: result.visualizerConfig,
      visualization: result.visualizerName,
    };
  }

  /**
   * Creates a runtime-agnostic visualization tool.
   */
  async createTool(): Promise<IRuntimeTool> {
    const visualizations = await this._getVisualizations();
    const graph = await this.visualizationGraph.build();
    const schema = z.object({
      prompt: z
        .string()
        .describe(
          `Prompt from the user that will be used for generating the visualization.`,
        ),
      datasetId: z
        .string()
        .optional()
        .describe(
          `ID of the dataset that needs to be visualized. Use the dataset ID from 'get-data-as-dataset' or 'improve-dataset' tool if available. If not provided, the tool will internally fetch the data.`,
        ),
      type: z
        .string()
        .optional()
        .describe(
          `Type of visualization to be generated. It can be one of the following: ${visualizations.map(v => v.name).join(', ')}. If not provided, the system will decide the best visualization based on the data and prompt.`,
        ),
    }) as AnyObject[string];
    return graph.asTool({
      name: this.key,
      description: `Generates a visualization for the user's request. It takes in a prompt and an optional dataset ID.
If the user's request involves trends, growth, decline, comparisons, distributions, patterns, correlations, or any analytical insight, ALWAYS use this tool instead of 'get-data-as-dataset'.
No need to call 'get-data-as-dataset' tool before this — if the dataset ID is not provided, this tool will internally fetch the data to be visualized.
It does not return anything, instead it fires an event internally that renders the visualization on the UI for the user to see.
It supports the following types of visualizations: ${visualizations.map(v => v.name).join(', ')}.`,
      schema,
    });
  }

  /**
   * @deprecated Use createTool().
   */
  async build(): Promise<IRuntimeTool> {
    return this.createTool();
  }

  private async _getVisualizations() {
    const bindings = this.context.findByTag({
      [VISUALIZATION_KEY]: true,
    });
    if (bindings.length === 0) {
      throw new Error(`Node with key ${VISUALIZATION_KEY} not found`);
    }
    return Promise.all(
      bindings.map(binding => this.context.get<IVisualizer>(binding.key)),
    );
  }
}

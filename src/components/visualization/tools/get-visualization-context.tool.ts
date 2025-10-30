import {Context, inject} from '@loopback/core';
import {graphTool} from '../../../decorators';
import {IGraphTool} from '../../../graphs';
import {VISUALIZATION_KEY} from '../keys';
import {IVisualizer} from '../types';
import {StructuredToolInterface, tool} from '@langchain/core/tools';
import {RunnableToolLike} from '@langchain/core/runnables';
import z from 'zod';
import {AnyObject} from '@loopback/repository';

@graphTool()
export class GetVisualizationContextTool implements IGraphTool {
  key = 'get-visualization-context';
  needsReview = false;

  constructor(
    @inject.context()
    private readonly context: Context,
  ) {}

  async build(): Promise<StructuredToolInterface | RunnableToolLike> {
    const visualizations = await this._getVisualizations();
    return tool(
      ({type}: {type: string}) => {
        const viz = visualizations.find(v => v.name === type);
        if (!viz) {
          throw new Error(`Visualization with type ${type} not found`);
        }
        return (
          viz.context ??
          'No additional context available for this visualization.'
        );
      },
      {
        name: this.key,
        description:
          'Tool to get the context information for a specific visualization type. ' +
          'Always call this before using generate/improve query tool if a visualization is needed or expected in the future. ' +
          'Use the response of this tool to inform the query tool about the structure expected for a visualization',
        schema: z.object({
          type: z
            .string()
            .optional()
            .describe(
              `Type of visualization to be generated. It can be one of the following: ${visualizations.map(v => v.name).join(', ')}. If not provided, the system will decide the best visualization based on the data and prompt.`,
            ),
        }) as AnyObject[string],
      },
    );
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

import {inject, service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool, IRuntimeTool, ToolStatus} from '../../../graphs';
import {DbQueryGraph} from '../db-query.graph';
import {DbQueryConfig, Errors, GenerationError} from '../types';
import {DbQueryAIExtensionBindings} from '../keys';
import {DEFAULT_MAX_READ_ROWS_FOR_AI} from '../constant';

@graphTool({
  description: `Query tool for generating SQL queries for a users request. Use it only when the user needs raw tabular data from the database.
                Do not use this tool if the user's request involves trends, growth, decline, comparisons, distributions, patterns, or any form of analytical insight — use the 'generate-visualization' tool instead.
                Note that it does not return the query, instead only a dataset ID that is not relevant to the user.
                It internally fires an event that renders a grid for the dataset on the UI for the user to see.`,
  inputSchema: z.object({
    prompt: z
      .string()
      .describe(
        `Prompt from the user that will be used for generating an SQL query and create a dataset from it.`,
      ),
  }),
})
export class GetDataAsDatasetTool implements IGraphTool {
  needsReview = false;
  key = 'get-data-as-dataset';
  description = `Query tool for generating SQL queries for a users request. Use it only when the user needs raw tabular data from the database.
                Do not use this tool if the user's request involves trends, growth, decline, comparisons, distributions, patterns, or any form of analytical insight — use the 'generate-visualization' tool instead.
                Note that it does not return the query, instead only a dataset ID that is not relevant to the user.
                It internally fires an event that renders a grid for the dataset on the UI for the user to see.`;
  inputSchema = z.object({
    prompt: z
      .string()
      .describe(
        `Prompt from the user that will be used for generating an SQL query and create a dataset from it.`,
      ),
  });
  constructor(
    @service(DbQueryGraph)
    private readonly queryPipeline: DbQueryGraph,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
  ) {}

  getValue(result: Record<string, string>): string {
    if (result.status === Errors.PermissionError) {
      return `Can not get data: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    if (result.status === GenerationError.Failed || !result.datasetId) {
      return `Can not get data: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    let resultSetString = '';
    if (result.resultArray) {
      resultSetString = ` First ${this.config.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI} results from the dataset are: ${JSON.stringify(result.resultArray)}`;
    }
    return `Dataset generated and has been rendered for the user. The dataset ID is ${result.datasetId}. Just tell the user that it is done.${resultSetString}`;
  }

  getMetadata(result: Record<string, string>): AnyObject {
    return {
      status: result.done ? ToolStatus.Completed : ToolStatus.Failed,
      existingDatasetId: result.datasetId,
    };
  }

  /**
   * Creates a runtime-agnostic tool for dataset generation.
   */
  async createTool(): Promise<IRuntimeTool> {
    const graph = await this.queryPipeline.build();
    const schema = z.object({
      prompt: z
        .string()
        .describe(
          `Prompt from the user that will be used for generating an SQL query and create a dataset from it.`,
        ),
    }) as AnyObject[string];
    return graph.asTool({
      name: this.key,
      description: `Query tool for generating SQL queries for a users request. Use it only when the user needs raw tabular data from the database.
                Do not use this tool if the user's request involves trends, growth, decline, comparisons, distributions, patterns, or any form of analytical insight — use the 'generate-visualization' tool instead.
                Note that it does not return the query, instead only a dataset ID that is not relevant to the user.
                It internally fires an event that renders a grid for the dataset on the UI for the user to see.`,
      schema,
    });
  }

  /**
   * @deprecated Use createTool().
   */
  async build(): Promise<IRuntimeTool> {
    return this.createTool();
  }
}

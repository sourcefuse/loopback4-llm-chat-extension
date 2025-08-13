import {service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool, ToolStatus} from '../../../graphs';
import {DbQueryGraph} from '../db-query.graph';
import {Errors, GenerationError} from '../types';

@graphTool()
export class GenerateQueryTool implements IGraphTool {
  needsReview = false;
  key = 'generate-query';
  constructor(
    @service(DbQueryGraph)
    private readonly queryPipeline: DbQueryGraph,
  ) {}

  getValue(result: Record<string, string>): string {
    if (result.status === Errors.PermissionError) {
      return `Can not generate query: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    if (result.status === GenerationError.Failed) {
      return `Can not generate query: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    return `Dataset generated and has been rendered for the user. The dataset ID is ${result.datasetId}, and here is the description of the query of the dataset - \n${result.replyToUser ?? 'No description provided'}`;
  }

  getMetadata(result: Record<string, string>): AnyObject {
    return {
      status: result.done ? ToolStatus.Completed : ToolStatus.Failed,
      existingDatasetId: result.datasetId,
    };
  }

  async build() {
    const graph = await this.queryPipeline.build();
    const schema = z.object({
      prompt: z
        .string()
        .describe(
          `Prompt from the user that will be used for generated the query`,
        ),
    }) as AnyObject[string];
    return graph.asTool({
      name: this.key,
      description: `Query tool for generating SQL queries for a users request. Use it to find data from the database based on the user's request.
                Note that it does not return the query, instead only a dataset ID that is not relevant to the user. 
                It internally fires an event that renders the dataset on the UI for the user to see.`,
      schema,
    });
  }
}

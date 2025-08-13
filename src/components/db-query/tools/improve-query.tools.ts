import {service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool, ToolStatus} from '../../../graphs';
import {DbQueryGraph} from '../db-query.graph';
import {Errors, GenerationError} from '../types';

@graphTool()
export class ImproveQueryTool implements IGraphTool {
  needsReview = false;
  key = 'improve-query';
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
      datasetId: z
        .string()
        .describe(`uuid ID of the dataset to improve the query for`),
      prompt: z
        .string()
        .describe(
          `A single prompt that describes the user's requirement for the query considering all the feedbacks and past attempts at query generation`,
        ),
    }) as AnyObject[string];
    return graph.asTool({
      name: this.key,
      description:
        'Tool for existing dataset based on id, it takes a prompt and returns a new dataset with the improved query. Call this only if you have a valid dataset ID available.',
      schema,
    });
  }
}

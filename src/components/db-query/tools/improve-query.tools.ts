import {inject, service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool, ToolStatus} from '../../../graphs';
import {DbQueryGraph} from '../db-query.graph';
import {DbQueryConfig, Errors, GenerationError} from '../types';
import {StructuredToolInterface} from '@langchain/core/tools';
import {RunnableToolLike} from '@langchain/core/runnables';
import {DbQueryAIExtensionBindings} from '../keys';
import {DEFAULT_MAX_READ_ROWS_FOR_AI} from '../constant';

@graphTool()
export class ImproveQueryTool implements IGraphTool {
  needsReview = false;
  key = 'improve-query';
  constructor(
    @service(DbQueryGraph)
    private readonly queryPipeline: DbQueryGraph,
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
  ) {}

  getValue(result: Record<string, string>): string {
    if (result.status === Errors.PermissionError) {
      return `Can not generate query: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    if (result.status === GenerationError.Failed || !result.datasetId) {
      return `Can not generate query: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    let resultSetString = '';
    if (result.resultArray) {
      resultSetString = ` First ${this.config.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI} results from the query are: ${JSON.stringify(result.resultArray)}`;
    }
    return `Dataset generated and has been rendered for the user. The dataset ID is ${result.datasetId}. Just tell the user that it is done.${resultSetString}`;
  }

  getMetadata(result: Record<string, string>): AnyObject {
    return {
      status: result.done ? ToolStatus.Completed : ToolStatus.Failed,
      existingDatasetId: result.datasetId,
    };
  }

  async build(): Promise<StructuredToolInterface | RunnableToolLike> {
    const graph = await this.queryPipeline.build();
    const schema = z.object({
      datasetId: z
        .string()
        .describe(`Database UUID ID of the dataset to improve the query for`),
      prompt: z
        .string()
        .describe(
          `A single prompt that describes the user's requirement for the query considering all the feedbacks and past attempts at query generation. This should be cover exactly what the user asked so far without any assumptions.`,
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

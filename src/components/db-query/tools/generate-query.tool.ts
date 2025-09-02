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
export class GenerateQueryTool implements IGraphTool {
  needsReview = false;
  key = 'generate-query';
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

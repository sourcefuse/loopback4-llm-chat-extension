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
export class GetDataAsDatasetTool implements IGraphTool {
  needsReview = false;
  key = 'get-data-as-dataset';
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

  async build(): Promise<StructuredToolInterface | RunnableToolLike> {
    const graph = await this.queryPipeline.build();
    const schema = z.object({
      prompt: z
        .string()
        .describe(
          `The user's request describing what data they need from the database.`,
        ),
    }) as AnyObject[string];
    return graph.asTool({
      name: this.key,
      description: `Tool for fetching data from the database and returning it as a dataset based on the user's request.
                Use this whenever the user wants to retrieve, look up, or explore data from the database.
                It returns a dataset ID and renders a data grid on the UI for the user to see the results.`,
      schema,
    });
  }
}

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
  description:
    'Tool for improving an existing dataset based on user feedback. It takes a dataset ID and a prompt describing the desired changes, and returns an updated dataset. Call this only if you have a valid dataset ID available.',
  inputSchema: z.object({
    datasetId: z
      .string()
      .describe(`UUID ID of the existing dataset to improve`),
    prompt: z
      .string()
      .describe(
        `A description of what changes or improvements the user wants in the existing dataset.`,
      ),
  }),
})
export class ImproveDatasetTool implements IGraphTool {
  needsReview = false;
  key = 'improve-dataset';
  description =
    'Tool for improving an existing dataset based on user feedback. It takes a dataset ID and a prompt describing the desired changes, and returns an updated dataset. Call this only if you have a valid dataset ID available.';
  inputSchema = z.object({
    datasetId: z
      .string()
      .describe(`UUID ID of the existing dataset to improve`),
    prompt: z
      .string()
      .describe(
        `A description of what changes or improvements the user wants in the existing dataset.`,
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
      return `Can not improve dataset: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    if (result.status === GenerationError.Failed || !result.datasetId) {
      return `Can not improve dataset: ${result.replyToUser ?? 'Unknown reason'}`;
    }
    let resultSetString = '';
    if (result.resultArray) {
      resultSetString = ` First ${this.config.maxRowsForAI ?? DEFAULT_MAX_READ_ROWS_FOR_AI} results from the dataset are: ${JSON.stringify(result.resultArray)}`;
    }
    return `Dataset improved and has been rendered for the user. The dataset ID is ${result.datasetId}. Just tell the user that it is done.${resultSetString}`;
  }

  getMetadata(result: Record<string, string>): AnyObject {
    return {
      status: result.done ? ToolStatus.Completed : ToolStatus.Failed,
      existingDatasetId: result.datasetId,
    };
  }

  /**
   * Creates a runtime-agnostic tool for dataset improvement.
   */
  async createTool(): Promise<IRuntimeTool> {
    const graph = await this.queryPipeline.build();
    const schema = z.object({
      datasetId: z
        .string()
        .describe(`UUID ID of the existing dataset to improve`),
      prompt: z
        .string()
        .describe(
          `A description of what changes or improvements the user wants in the existing dataset.`,
        ),
    }) as AnyObject[string];
    return graph.asTool({
      name: this.key,
      description:
        'Tool for improving an existing dataset based on user feedback. It takes a dataset ID and a prompt describing the desired changes, and returns an updated dataset. Call this only if you have a valid dataset ID available.',
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

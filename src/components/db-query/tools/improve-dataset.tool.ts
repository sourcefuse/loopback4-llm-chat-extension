import {inject, service} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool, IRuntimeTool, ToolStatus} from '../../../types/tool';
import {
  MastraDbQueryWorkflow,
  MastraDbQueryContext,
} from '../../../mastra/db-query';
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
    @inject(DbQueryAIExtensionBindings.Config)
    private readonly config: DbQueryConfig,
    @service(MastraDbQueryWorkflow)
    private readonly mastraWorkflow: MastraDbQueryWorkflow,
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
   * Creates a Mastra-compatible `IRuntimeTool` that executes the imperative workflow.
   */
  async createTool(): Promise<IRuntimeTool> {
    return {
      name: this.key,
      description: this.description,
      schema: this.inputSchema,
      invoke: async (
        input: unknown,
        opts?: {
          writer?: MastraDbQueryContext['writer'];
          signal?: AbortSignal;
        },
      ) => {
        const {datasetId, prompt} = input as {
          datasetId: string;
          prompt: string;
        };
        return this.mastraWorkflow.run(
          {prompt, datasetId},
          {
            writer: opts?.writer,
            signal: opts?.signal,
          },
        );
      },
    } as IRuntimeTool;
  }

  /**
   * @deprecated Use createTool().
   */
  async build(): Promise<IRuntimeTool> {
    return this.createTool();
  }
}

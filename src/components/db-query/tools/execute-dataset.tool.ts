import {inject} from '@loopback/core';
import {AnyObject} from '@loopback/repository';
import {z} from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool} from '../../../graphs';
import {DataSetHelper} from '../services';
import {StructuredToolInterface} from '@langchain/core/tools';

/**
 * Tool to execute a dataset query and retrieve actual data values.
 * This complements the generate-query tool by executing the generated query.
 *
 * Usage flow:
 * 1. LLM calls generate-query → gets dataset ID
 * 2. LLM calls execute-dataset with dataset ID → gets actual data values
 * 3. LLM uses those values in fill-form or other tools
 */
@graphTool()
export class ExecuteDatasetTool implements IGraphTool {
  needsReview = false;
  key = 'execute-dataset';

  constructor(
    @inject('services.DataSetHelper')
    private readonly datasetHelper: DataSetHelper,
  ) {}

  getValue(result: Record<string, string>): string {
    if (result.error) {
      return `Error executing dataset: ${result.error}`;
    }

    const datasetId = result.datasetId;
    const data = result.data;

    if (!data || data.length === 0) {
      return `Dataset ${datasetId} executed successfully but returned no results.`;
    }

    // Format the results for the LLM
    const resultCount = data.length;
    const firstResult = data[0];
    const columns = Object.keys(firstResult).join(', ');

    let response = `Dataset ${datasetId} executed successfully. `;
    response += `Returned ${resultCount} row(s) with columns: ${columns}.\n\n`;
    response += `Results:\n${JSON.stringify(data, null, 2)}`;

    return response;
  }

  async build(): Promise<StructuredToolInterface> {
    const {tool} = await import('@langchain/core/tools');

    return tool(
      async (input: {datasetId: string; limit?: number}) => {
        try {
          // Execute the dataset query
          const data = await this.datasetHelper.getDataFromDataset(
            input.datasetId,
            input.limit || 10, // Default to 10 rows
            0, // offset
          );

          return {
            datasetId: input.datasetId,
            data,
            rowCount: Array.isArray(data) ? data.length : 0,
          };
        } catch (error) {
          return {
            datasetId: input.datasetId,
            error: error.message || 'Failed to execute dataset',
            data: null,
          };
        }
      },
      {
        name: this.key,
        description: `Executes a dataset query and returns the actual data results.

IMPORTANT: Use this tool AFTER calling generate-query when you need the actual data values.

Usage flow:
1. Call generate-query to create a dataset and get a dataset ID
2. Call this tool (execute-dataset) with that dataset ID to get the actual results
3. Use the returned data values in your response or in other tools like fill-form

Example:
- generate-query("Get email for employee EMP123") → returns dataset ID "ds_123"
- execute-dataset(datasetId="ds_123") → returns [{"email": "john@company.com"}]`,
        schema: z.object({
          datasetId: z
            .string()
            .describe('The dataset ID returned by generate-query tool'),
          limit: z
            .number()
            .optional()
            .describe('Maximum number of rows to return (default: 10)'),
        }) as AnyObject[string],
      },
    ) as any;
  }
}

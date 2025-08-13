import {tool} from '@langchain/core/tools';
import {VectorStore} from '@langchain/core/vectorstores';
import {inject} from '@loopback/context';
import {AnyObject} from '@loopback/repository';
import z from 'zod';
import {graphTool} from '../../../decorators';
import {IGraphTool} from '../../../graphs';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryStoredTypes, IDataSetStore} from '../types';

@graphTool()
export class MarkDatasetAsValidTool implements IGraphTool {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly datasets: IDataSetStore,
    @inject(AiIntegrationBindings.VectorStore)
    private readonly vectorStore: VectorStore,
  ) {}

  key = 'mark-dataset-as-valid';
  needsReview = false;

  async build() {
    const schema = z.object({
      datasetId: z.string().describe('uuid ID of the dataset to mark as valid'),
    }) as AnyObject[string];

    return tool(
      async (args: {datasetId: string; question: string}) => {
        const {query, prompt, valid} = await this.datasets.findById(
          args.datasetId,
        );
        if (valid) {
          return `Dataset with ID ${args.datasetId} is already marked as valid.`;
        }
        await this.datasets.updateById(args.datasetId, {
          valid: true,
        });

        await this.vectorStore.addDocuments([
          {
            pageContent: prompt,
            metadata: {
              datasetId: args.datasetId,
              query,
              type: DbQueryStoredTypes.DataSet,
            },
          },
        ]);
        return `Dataset with ID ${args.datasetId} has been marked as valid and added to cache`;
      },
      {
        name: this.key,
        description:
          'Tool for marking a dataset as valid and adding it to the knowledge base for future use. Use this when user confirms that the dataset is correct.',
        schema,
      },
    );
  }
}

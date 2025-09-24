import {VectorStore} from '@langchain/core/vectorstores';
import {inject, service} from '@loopback/core';
import {Filter} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryStoredTypes, IDataSet, IDataSetStore} from '../types';
import {PermissionHelper} from './permission-helper.service';
import {DatasetUpdateDTO} from '../models/dataset-update-dto.model';

export class DataSetHelper {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
    @service(PermissionHelper)
    private readonly permissionHelper: PermissionHelper,
    @inject(AiIntegrationBindings.VectorStore)
    private readonly vectorStore: VectorStore,
  ) {}

  async checkPermissions(datasetId: string) {
    const dataset = await this.store.findById(datasetId);
    return this.permissionHelper.findMissingPermissions(dataset.tables);
  }

  async getDataFromDataset(id: string, limit?: number, offset?: number) {
    const [dataset] = await this.store.find({
      where: {
        id,
      },
    });

    if (!dataset) {
      throw new HttpErrors.NotFound(`Dataset with id ${id} not found`);
    }

    const missingPermissions = this.permissionHelper.findMissingPermissions(
      dataset.tables,
    );

    if (missingPermissions.length > 0) {
      throw new HttpErrors.Unauthorized();
    }

    return this.store.getData(id, limit, offset);
  }

  async find(filter?: Filter<IDataSet>) {
    return this.store.find(filter);
  }

  async updateById(id: string, data: DatasetUpdateDTO) {
    const dataset = await this.store.updateLikes(id, data.liked, data.comment);
    // clear from cache and re-add if likes > 0
    await this.vectorStore.delete({
      filter: {
        metadata: {
          datasetId: id,
          tenantId: dataset.tenantId,
        },
      },
    });
    if (dataset.votes > 0) {
      await this.vectorStore.addDocuments([
        {
          pageContent: dataset.description,
          metadata: {
            datasetId: id,
            votes: dataset.votes,
            type: DbQueryStoredTypes.DataSet,
            tenantId: dataset.tenantId,
          },
        },
      ]);
    }
  }

  async getLikes(id: string) {
    return this.store.getLikes(id);
  }
}

import {inject, service} from '@loopback/core';
import {Filter} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryStoredTypes, IDataSet, IDataSetStore} from '../types';
import {PermissionHelper} from './permission-helper.service';
import {DatasetUpdateDTO} from '../models/dataset-update-dto.model';
import {SemanticCacheService} from './semantic-cache.service';

export class DataSetHelper {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
    @service(PermissionHelper)
    private readonly permissionHelper: PermissionHelper,
    @service(SemanticCacheService)
    private readonly semanticCache: SemanticCacheService,
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
    await this.semanticCache.deleteByFilter({
      type: DbQueryStoredTypes.DataSet,
      datasetId: id,
      tenantId: dataset.tenantId,
    });
    if (dataset.votes > 0) {
      await this.semanticCache.upsertDocument({
        pageContent: dataset.prompt,
        metadata: {
          id,
          datasetId: id,
          votes: dataset.votes,
          description: dataset.description,
          type: DbQueryStoredTypes.DataSet,
          tenantId: dataset.tenantId,
          query: dataset.query,
        },
      });
    }
  }

  async getLikes(id: string) {
    return this.store.getLikes(id);
  }
}

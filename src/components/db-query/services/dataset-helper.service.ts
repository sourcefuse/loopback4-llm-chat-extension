import {inject, service} from '@loopback/core';
import debugFactory from 'debug';
import {Filter} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryStoredTypes, IDataSet, IDataSetStore} from '../types';
import {PermissionHelper} from './permission-helper.service';
import {DatasetUpdateDTO} from '../models/dataset-update-dto.model';
import {SemanticCacheService} from './semantic-cache.service';

const debug = debugFactory('ai-integration:dataset-helper');

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
    // The vote/like update above is the canonical write and has committed.
    // Refreshing the semantic cache (clear, then re-add when likes > 0) is
    // best-effort maintenance — a vector-store hiccup must not fail the
    // user's like action. Log and continue; the cache self-heals on the
    // next search/upsert.
    try {
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
    } catch (err) {
      debug('dataset %s cache refresh failed (non-fatal): %O', id, err);
    }
  }

  async getLikes(id: string) {
    return this.store.getLikes(id);
  }

  /**
   * Soft-delete a single dataset and evict its semantic-cache entry. The
   * store.deleteById is the canonical write; cache eviction is best-effort
   * (a vector-store hiccup must not fail the delete).
   */
  async deleteById(id: string) {
    const dataset = await this.store.findById(id);
    await this.store.deleteById(id);
    try {
      await this.semanticCache.deleteByFilter({
        type: DbQueryStoredTypes.DataSet,
        datasetId: id,
        tenantId: dataset.tenantId,
      });
    } catch (err) {
      debug(
        'dataset %s cache eviction on delete failed (non-fatal): %O',
        id,
        err,
      );
    }
  }

  /**
   * Bulk soft-delete datasets by id (tenant-scoped via the store's
   * authn-aware deleteAll). Returns the number deleted. Cache eviction is
   * best-effort per id.
   */
  async deleteMany(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const {count} = await this.store.deleteAll({id: {inq: ids}});
    for (const id of ids) {
      try {
        await this.semanticCache.deleteByFilter({
          type: DbQueryStoredTypes.DataSet,
          datasetId: id,
        });
      } catch (err) {
        debug('dataset %s cache eviction on bulk-delete failed: %O', id, err);
      }
    }
    return count;
  }
}

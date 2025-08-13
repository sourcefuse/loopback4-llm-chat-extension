import {VectorStore} from '@langchain/core/vectorstores';
import {inject, service} from '@loopback/core';
import {Filter} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {AiIntegrationBindings} from '../../../keys';
import {DbQueryAIExtensionBindings} from '../keys';
import {DbQueryStoredTypes, IDataSet, IDataSetStore} from '../types';
import {PermissionHelper} from './permission-helper.service';

export class DataSetHelper {
  constructor(
    @inject(DbQueryAIExtensionBindings.DatasetStore)
    private readonly store: IDataSetStore,
    @service(PermissionHelper)
    private readonly permissionHelper: PermissionHelper,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly currentUser: IAuthUserWithPermissions,
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

  async updateById(id: string, data: Partial<IDataSet>) {
    const where = {
      createdBy: this.currentUser.userTenantId,
      id,
    };
    if (data.valid === true) {
      const {prompt, query, valid} = await this.store.findById(id);
      if (!valid) {
        await this.vectorStore.addDocuments([
          {
            pageContent: prompt,
            metadata: {
              datasetId: id,
              query,
              type: DbQueryStoredTypes.DataSet,
            },
          },
        ]);
      }
    }
    if (data.valid === false && !data.feedback) {
      throw new HttpErrors.UnprocessableEntity(
        'Feedback is required when marking a dataset as invalid',
      );
    }
    return this.store.updateAll(data, where);
  }
}

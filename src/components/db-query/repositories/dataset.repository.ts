import {Getter, inject} from '@loopback/core';
import {
  HasManyRepositoryFactory,
  juggler,
  repository,
} from '@loopback/repository';
import {HttpErrors} from '@loopback/rest';
import {
  DefaultTransactionalUserModifyRepository,
  IAuthUserWithPermissions,
} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {WriterDB} from '../../../keys';
import {DatasetActionType} from '../constant';
import {DbQueryAIExtensionBindings} from '../keys';
import {DataSet, DatasetAction} from '../models';
import {IDatasetAction, IDataSetStore, IDbConnector} from '../types';
import {DatasetActionRepository} from './dataset-action.repository';

export class DataSetRepository
  extends DefaultTransactionalUserModifyRepository<
    DataSet,
    typeof DataSet.prototype.id
  >
  implements IDataSetStore
{
  public readonly actions: HasManyRepositoryFactory<
    DatasetAction,
    typeof DatasetAction.prototype.id
  >;
  constructor(
    @inject(`datasources.${WriterDB}`)
    private ds: juggler.DataSource,
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    public getCurrentUser: Getter<IAuthUserWithPermissions>,
    @inject(DbQueryAIExtensionBindings.Connector)
    private readonly dbConnector: IDbConnector,
    @repository.getter(DatasetActionRepository)
    private readonly datasetActionRepoGetter: Getter<DatasetActionRepository>,
  ) {
    super(DataSet, ds, getCurrentUser);
    this.actions = this.createHasManyRepositoryFactoryFor(
      'actions',
      datasetActionRepoGetter,
    );
    this.registerInclusionResolver('actions', this.actions.inclusionResolver);
  }

  async getData<T>(id: string, limit?: number, offset?: number): Promise<T[]> {
    const dataset = await this.findById(id);
    return this.dbConnector.execute<T>(dataset.query, limit, offset);
  }

  async updateLikes(datasetId: string, liked: boolean, comment?: string) {
    const transaction = await this.beginTransaction();
    const user = await this.getCurrentUser();
    try {
      const dataset = await this.findById(
        datasetId,
        {
          include: [
            {
              relation: 'actions',
              scope: {
                where: {userId: user.userTenantId},
              },
            },
          ],
        },
        {transaction},
      );
      if (!dataset) {
        throw new Error(`Dataset with id ${datasetId} not found`);
      }
      if (
        liked === true &&
        dataset.actions?.length === 1 &&
        dataset.actions[0].action === DatasetActionType.Disliked
      ) {
        // add 2, one to cancel the dislike and one for the like
        dataset.votes = (dataset.votes || 0) + 2;
        await this.updateById(datasetId, {votes: dataset.votes}, {transaction});
        await this.actions(datasetId).patch(
          {
            action: DatasetActionType.Liked,
            comment: null,
          },
          {
            userId: user.userTenantId,
          },
          {transaction},
        );
      } else if (
        liked === false &&
        dataset.actions?.length === 1 &&
        dataset.actions[0].action === DatasetActionType.Liked
      ) {
        if (!comment) {
          throw new HttpErrors.UnprocessableEntity(
            'Comment is required when marking dataset as disliked',
          );
        }
        dataset.votes = (dataset.votes || 0) - 2;
        await this.updateById(
          datasetId,
          // subtract 2, one to cancel the like and one for the dislike
          {votes: dataset.votes},
          {transaction},
        );
        await this.actions(datasetId).patch(
          {
            action: DatasetActionType.Disliked,
            comment,
          },
          {
            userId: user.userTenantId,
          },
          {transaction},
        );
      } else if (liked === null && dataset.actions?.length === 1) {
        dataset.votes =
          dataset.actions[0].action === DatasetActionType.Liked
            ? (dataset.votes || 0) - 1
            : (dataset.votes || 0) + 1;
        await this.updateById(
          datasetId,
          {
            votes: dataset.votes,
          },
          {transaction},
        );
        await this.actions(datasetId).delete(
          {
            userId: user.userTenantId,
          },
          {transaction},
        );
      } else if (!dataset.actions || dataset.actions?.length === 0) {
        if (liked === null) {
          throw new HttpErrors.BadRequest(
            'Invalid operation. Cannot remove like/dislike before liking/disliking',
          );
        }
        if (liked === false && !comment) {
          throw new HttpErrors.UnprocessableEntity(
            'Comment is required when marking dataset as disliked',
          );
        }
        await this.actions(datasetId).create(
          {
            action: liked
              ? DatasetActionType.Liked
              : DatasetActionType.Disliked,
            userId: user.userTenantId,
            comment,
          },
          {transaction},
        );
        dataset.votes = (dataset.votes || 0) + (liked ? 1 : -1);
        await this.updateById(datasetId, {votes: dataset.votes}, {transaction});
      } else {
        throw new HttpErrors.Conflict(
          'Can only have one action of a type per user',
        );
      }
      await transaction.commit();
      return dataset;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async getLikes(datasetId: string): Promise<IDatasetAction | null> {
    const user = await this.getCurrentUser();
    const actions = await this.actions(datasetId).find({
      where: {
        userId: user.userTenantId,
      },
      order: ['actedOn DESC'],
    });
    if (actions.length === 0) return null;
    if (actions.length > 1) {
      throw new HttpErrors.Conflict('Multiple actions found for the user');
    }
    return actions[0];
  }
}

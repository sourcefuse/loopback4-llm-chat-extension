import {Getter, inject} from '@loopback/core';
import {
  DefaultTransactionalRepository,
  Filter,
  juggler,
  Options,
} from '@loopback/repository';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {DatasetAction} from '../models';
import {WriterDB} from '../../../keys';

export class DatasetActionRepository extends DefaultTransactionalRepository<
  DatasetAction,
  typeof DatasetAction.prototype.id
> {
  constructor(
    @inject(`datasources.${WriterDB}`)
    private ds: juggler.DataSource,
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    public getCurrentUser: Getter<IAuthUserWithPermissions>,
  ) {
    super(DatasetAction, ds);
  }

  async find(
    filter?: Filter<DatasetAction> | undefined,
    options?: Options,
  ): Promise<DatasetAction[]> {
    const user = await this.getCurrentUser();
    if (options?.skipUserFilter === true) {
      return super.find(filter, options);
    }
    filter = filter ?? {};
    filter.where = {
      and: [filter.where ?? {}, {userId: user.userTenantId}],
    };
    return super.find(filter, options);
  }
}

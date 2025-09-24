import {Getter, inject} from '@loopback/core';
import {DefaultTransactionalRepository, juggler} from '@loopback/repository';
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
}

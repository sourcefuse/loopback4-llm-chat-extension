import {Getter, inject} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {
  DefaultUserModifyCrudRepository,
  IAuthUserWithPermissions,
} from '@sourceloop/core';
import {AuthenticationBindings} from 'loopback4-authentication';
import {DataSet} from '../models';
import {IDataSetStore} from '../types';

export class DataSetRepository
  extends DefaultUserModifyCrudRepository<DataSet, typeof DataSet.prototype.id>
  implements IDataSetStore
{
  constructor(
    private ds: juggler.DataSource,
    @inject.getter(AuthenticationBindings.CURRENT_USER)
    public getCurrentUser: Getter<IAuthUserWithPermissions>,
    @inject('datasources.db')
    private readonly mainDs: juggler.DataSource,
  ) {
    super(DataSet, ds, getCurrentUser);
  }

  async getData<T>(id: string, limit?: number, offset?: number): Promise<T> {
    const dataset = await this.findById(id);
    let limitOffsetQuery = '';
    let params: number[] = [];
    if (limit && offset) {
      limitOffsetQuery = ` LIMIT $1 OFFSET $2`;
      params = [limit, offset];
    } else if (limit) {
      limitOffsetQuery = ` LIMIT $1`;
      params = [limit];
    } else if (offset) {
      limitOffsetQuery = ` OFFSET $1`;
      params = [offset];
    } else {
      params = [];
    }
    // remove the last semicolon if it exists
    const query = dataset.query.trim();
    if (query.endsWith(';')) {
      dataset.query = query.slice(0, -1);
    }
    return this.mainDs.execute(
      `SELECT * FROM (${dataset.query}) AS subquery${limitOffsetQuery}`,
      params,
    );
  }
}

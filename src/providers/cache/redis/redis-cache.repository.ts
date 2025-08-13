import {inject} from '@loopback/core';
import {DefaultKeyValueRepository, juggler} from '@loopback/repository';
import {CacheModel} from '../cache.model';

export class RedisCacheRepository extends DefaultKeyValueRepository<CacheModel> {
  constructor(
    @inject('datasources.redis')
    protected dataSource: juggler.DataSource,
  ) {
    super(CacheModel, dataSource);
  }
}

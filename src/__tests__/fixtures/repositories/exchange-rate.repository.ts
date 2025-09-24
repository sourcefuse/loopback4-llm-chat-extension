import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {ExchangeRate} from '../models';

export class ExchangeRateRepository extends DefaultCrudRepository<
  ExchangeRate,
  typeof ExchangeRate.prototype.id
> {
  constructor(@inject('datasources.readerdb') dataSource: juggler.DataSource) {
    super(ExchangeRate, dataSource);
  }
}

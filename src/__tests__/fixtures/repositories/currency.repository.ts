import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {Currency} from '../models';

export class CurrencyRepository extends DefaultCrudRepository<
  Currency,
  typeof Currency.prototype.id
> {
  constructor(@inject('datasources.readerdb') dataSource: juggler.DataSource) {
    super(Currency, dataSource);
  }
}

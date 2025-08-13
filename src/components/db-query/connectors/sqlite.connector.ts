import {inject} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {IDbConnector} from '../types';
import {PgConnector} from './pg.connector';

export class SqliteConnector extends PgConnector implements IDbConnector {
  override operatorMap: Record<string, string> = {
    string: 'TEXT',
    number: 'INTEGER',
    boolean: 'BOOLEAN',
    date: 'TIMESTAMP WITH TIME ZONE',
    object: 'TEXT',
    array: 'TEXT',
  };
  constructor(@inject('datasources.db') dataSource: juggler.DataSource) {
    super(dataSource);
  }
}

import {inject} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {IDbConnector} from '../types';
import {PgConnector} from './pg/pg.connector';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from '@sourceloop/core';

export class SqliteConnector extends PgConnector implements IDbConnector {
  override operatorMap: Record<string, string> = {
    string: 'TEXT',
    number: 'INTEGER',
    boolean: 'BOOLEAN',
    date: 'TIMESTAMP WITH TIME ZONE',
    object: 'TEXT',
    array: 'TEXT',
  };
  constructor(
    @inject('datasources.readerdb') dataSource: juggler.DataSource,
    @inject(AuthenticationBindings.CURRENT_USER, {optional: true})
    protected readonly user?: IAuthUserWithPermissions,
  ) {
    super(dataSource, user);
  }
}

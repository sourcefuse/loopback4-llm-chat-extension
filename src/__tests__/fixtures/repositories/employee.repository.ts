import {inject} from '@loopback/core';
import {DefaultCrudRepository, juggler} from '@loopback/repository';
import {Employee} from '../models';

export class EmployeeRepository extends DefaultCrudRepository<
  Employee,
  typeof Employee.prototype.id
> {
  constructor(@inject('datasources.readerdb') dataSource: juggler.DataSource) {
    super(Employee, dataSource);
  }
}

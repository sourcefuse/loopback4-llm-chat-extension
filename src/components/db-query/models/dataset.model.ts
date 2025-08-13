import {model, property} from '@loopback/repository';
import {UserModifiableEntity} from '@sourceloop/core';
import {IDataSet} from '../types';

@model({
  name: 'datasets',
})
export class DataSet extends UserModifiableEntity implements IDataSet {
  @property({
    id: true,
    type: 'string',
    generated: true,
    description: 'Unique identifier for the dataset',
  })
  id?: string;

  @property({
    type: 'string',
    required: true,
    description: 'SQL query for the dataset',
  })
  query: string;

  @property({
    type: 'string',
    required: true,
    description: 'Description of the dataset',
  })
  description: string;

  @property({
    type: 'array',
    itemType: 'string',
    required: true,
    description: 'List of tables used in the query of the dataset',
    postgresql: {
      dataType: 'varchar[]',
    },
  })
  tables: string[];

  @property({
    name: 'schema_hash',
    type: 'string',
    required: true,
    description: 'Hash of the schema used to generate the dataset',
  })
  schemaHash: string;

  @property({
    name: 'tenant_id',
    type: 'string',
    required: true,
    description: 'Tenant ID of the user',
  })
  tenantId: string;

  @property({
    type: 'boolean',
    default: false,
    description:
      'Indicates if the dataset is valid and can be used for queries',
  })
  valid: boolean | null;

  @property({
    type: 'string',
    default: false,
    description: 'The prompt that was used to generate the dataset',
  })
  prompt: string;

  @property({
    type: 'string',
    description: 'Feedback provided by the user for the dataset',
    required: false,
  })
  feedback?: string;

  constructor(data?: Partial<DataSet>) {
    super(data);
  }
}

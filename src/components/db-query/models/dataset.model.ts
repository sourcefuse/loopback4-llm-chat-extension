import {hasMany, model, property} from '@loopback/repository';
import {UserModifiableEntity} from '@sourceloop/core';
import {IDataSet} from '../types';
import {DatasetAction} from './dataset-action.model';

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
    type: 'number',
    default: false,
    description:
      'Indicates the number of votes the dataset has received. Null if not voted on. It also goes down if it is disliked.',
  })
  votes: number;

  @property({
    type: 'string',
    default: false,
    description: 'The prompt that was used to generate the dataset',
  })
  prompt: string;

  @hasMany(() => DatasetAction, {
    name: 'actions',
    keyTo: 'datasetId',
    keyFrom: 'id',
  })
  actions?: DatasetAction[];

  constructor(data?: Partial<DataSet>) {
    super(data);
  }
}

import {belongsTo, Entity, model, property} from '@loopback/repository';
import {DataSet} from './dataset.model';
import {DatasetActionType} from '../constant';

@model({
  name: 'dataset_actions',
})
export class DatasetAction extends Entity {
  @property({
    id: true,
    type: 'string',
    generated: true,
    description: 'Unique identifier for the dataset action',
  })
  id?: string;

  @belongsTo(
    () => DataSet,
    {},
    {
      name: 'dataset_id',
      type: 'string',
      required: true,
      description: 'ID of the dataset on which the action is performed',
    },
  )
  datasetId: string;

  @property({
    type: 'number',
    required: true,
    description: 'Whether the user liked the dataset or not',
  })
  action: DatasetActionType;

  @property({
    type: 'date',
    name: 'acted_on',
    description: 'Timestamp when the action was performed',
  })
  actedOn?: Date;

  @property({
    name: 'user_id',
    type: 'string',
    required: true,
    description: 'ID of the user who performed the action',
  })
  userId: string;

  @property({
    type: 'string',
    description: 'Optional comment for the dataset in case invalid',
  })
  comment?: string | null;

  constructor(data?: Partial<DatasetAction>) {
    super(data);
  }
}

export interface DatasetActionRelations {
  // describe navigational properties here
  dataset?: DataSet;
}

export type DatasetActionWithRelations = DatasetAction & DatasetActionRelations;

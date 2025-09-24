import {model, Model, property} from '@loopback/repository';

@model()
export class DatasetUpdateDTO extends Model {
  @property({
    type: 'boolean',
    description:
      'To like or dislike the dataset, true for like, false for dislike',
    jsonSchema: {
      nullable: true,
    },
  })
  liked: boolean | null;

  @property({
    type: 'string',
    description: 'optional feedback for the dataset in case of invalid dataset',
  })
  comment?: string;

  constructor(data?: Partial<DatasetUpdateDTO>) {
    super(data);
  }
}

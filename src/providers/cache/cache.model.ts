import {Entity, property} from '@loopback/repository';

export class CacheModel extends Entity {
  @property({
    type: 'string',
    id: true,
    required: true,
  })
  key: string;

  @property({
    type: 'string',
    required: true,
  })
  value: string;
  constructor(data?: Partial<CacheModel>) {
    super(data);
  }
}

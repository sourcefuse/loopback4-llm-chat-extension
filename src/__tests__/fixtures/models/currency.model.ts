import {Entity, model, property} from '@loopback/repository';

@model({
  name: 'currencies', // Use plural form for table name
  settings: {
    description: 'Model representing currencies in the system.',
  },
})
export class Currency extends Entity {
  @property({
    type: 'string',
    id: true,
    description: 'Unique identifier for the currency record',
  })
  id?: string;

  @property({
    type: 'string',
    required: true,
    description: 'Name of the currency',
  })
  name: string;

  @property({
    type: 'string',
    required: true,
    description: 'ISO3 code of the currency (e.g. USD, EUR)',
  })
  code: string;

  constructor(data?: Partial<Currency>) {
    super(data);
  }
}

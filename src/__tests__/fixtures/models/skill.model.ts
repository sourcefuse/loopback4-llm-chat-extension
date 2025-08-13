import {Entity, model, property} from '@loopback/repository';

@model({
  name: 'skills', // Use plural form for table name
  settings: {
    description: 'Model representing the skills available in the .',
  },
})
export class Skill extends Entity {
  @property({
    type: 'string',
    id: true,
    description: 'Unique identifier for the skill record',
  })
  id?: string;

  @property({
    type: 'string',
    required: true,
    description: 'Name of the skill',
  })
  name: string;

  constructor(data?: Partial<Skill>) {
    super(data);
  }
}

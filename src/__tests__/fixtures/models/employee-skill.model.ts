import {Entity, model, property} from '@loopback/repository';

@model({
  name: 'employee_skills', // Use plural form for table name
  settings: {
    description:
      'Mapping table between employee and skill representing a many to many relation.',
  },
})
export class EmployeeSkill extends Entity {
  @property({
    type: 'string',
    id: true,
    description: 'Unique identifier for the employee-skill mapping record',
  })
  id?: string;

  @property({
    name: 'skill_id',
    type: 'string',
    required: true,
    description: 'ID of the skill',
  })
  skillId: string;

  @property({
    name: 'employee_id',
    type: 'string',
    required: true,
    description: 'ID of the employee',
  })
  employeeId: string;

  constructor(data?: Partial<EmployeeSkill>) {
    super(data);
  }
}

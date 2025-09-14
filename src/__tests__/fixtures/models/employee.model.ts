import {
  belongsTo,
  Entity,
  hasMany,
  model,
  property,
} from '@loopback/repository';
import {Currency} from './currency.model';
import {EmployeeSkill} from './employee-skill.model';
import {Skill} from './skill.model';

@model({
  name: 'employees', // Use plural form for table name
  settings: {
    description: 'Model representing an employee in the system.',
    context: [
      'employee salary must be converted to USD, using the currency_id column and the exchange rate table',
    ],
  },
})
export class Employee extends Entity {
  @property({
    type: 'string',
    id: true,
    description: 'Unique identifier for the employee record',
  })
  id?: string;

  @property({
    type: 'string',
    required: true,
    description: 'Name of the employee',
  })
  name: string;

  @property({
    type: 'string',
    required: true,
    description: 'Unique code for the employee, used for identification',
  })
  code: string;

  @property({
    type: 'number',
    required: true,
    description:
      'The salary of the employee in the currency stored in currency_id column',
  })
  salary: number;

  @property({
    type: 'string',
    required: true,
    postgresql: {
      dataType: 'date',
    },
    description: 'The date when the employee joined the company',
  })
  joiningDate: string;

  @belongsTo(
    () => Currency,
    {name: 'currency'},
    {
      name: 'currency_id',
      type: 'string',
      description:
        'The ID of the currency for the employees salary. Use this to convert the salary to USD along with the exchange rate table.',
    },
  )
  currencyId: string;

  @hasMany(() => Skill, {
    keyFrom: 'id',
    through: {
      model: () => EmployeeSkill,
      keyFrom: 'employeeId',
      keyTo: 'skillId',
    },
  })
  skills: Skill[];

  constructor(data?: Partial<Employee>) {
    super(data);
  }
}

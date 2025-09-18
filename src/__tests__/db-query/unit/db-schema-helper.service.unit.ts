import {juggler} from '@loopback/repository';
import {expect} from '@loopback/testlab';
import {
  DbSchemaHelperService,
  PgConnector,
  SchemaStore,
} from '../../../components';
import {
  Currency,
  Employee,
  EmployeeSkill,
  ExchangeRate,
  Skill,
} from '../../fixtures/models';
import {SupportedDBs} from '../../../types';

describe(`DbSchemaHelperService Unit`, () => {
  let service: DbSchemaHelperService;

  beforeEach(() => {
    const connector = new juggler.DataSource({
      connector: 'memory',
      name: 'db',
    });

    const pg = new PgConnector(connector);
    service = new DbSchemaHelperService(pg, {
      models: [],
      db: {
        dialect: SupportedDBs.PostgreSQL,
        ignoredColumns: ['deleted', 'delete_reason'],
      },
    });
  });

  it('should transform the schema correctly', async () => {
    const schema = service.modelToSchema('public', [
      Employee,
      Currency,
      ExchangeRate,
      Skill,
      EmployeeSkill,
    ]);

    expect(schema.tables).have.keys(
      'public.employees',
      'public.currencies',
      'public.exchange_rates',
      'public.skills',
      'public.employee_skills',
    );

    expect(
      schema.tables['public.employees'].columns['joiningdate'].metadata,
    ).to.deepEqual(Employee.definition.properties['joiningDate']);

    expect(
      schema.tables['public.employees'].columns['deleted'],
    ).to.be.undefined();
    expect(
      schema.tables['public.employees'].columns['delete_reason'],
    ).to.be.undefined();

    expect(schema.relations).to.have.length(3);

    expect(schema.relations[0]).to.deepEqual({
      type: 'belongsTo',
      table: 'public.employees',
      column: 'currency_id',
      referencedTable: 'public.currencies',
      referencedColumn: 'id',
      description: '',
    });

    expect(schema.relations[1]).to.deepEqual({
      type: 'hasManyThrough',
      table: 'public.employee_skills',
      column: 'employee_id',
      referencedTable: 'public.employees',
      referencedColumn: 'id',
      description:
        'left side of has many through relation from public.employees to public.skills via public.employee_skills',
    });

    expect(schema.relations[2]).to.deepEqual({
      type: 'hasManyThrough',
      table: 'public.employee_skills',
      column: 'skill_id',
      referencedTable: 'public.skills',
      referencedColumn: 'id',
      description:
        'right side of has many through relation from public.employees to public.skills via public.employee_skills',
    });
  });
});

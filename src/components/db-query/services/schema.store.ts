import {BindingScope, injectable} from '@loopback/core';
import {DatabaseSchema} from '../types';

@injectable({scope: BindingScope.SINGLETON})
export class SchemaStore {
  constructor() {}
  private schema?: DatabaseSchema;

  async save(schema: DatabaseSchema): Promise<void> {
    this.schema = schema;
  }

  get() {
    if (!this.schema) {
      throw new Error('Schema is not defined');
    }
    return this.schema;
  }

  filteredSchema(tables: string[]): DatabaseSchema {
    const schema = this.schema;
    if (!schema) {
      throw new Error('Schema is not defined');
    }
    const newTables = Object.keys(schema.tables).reduce(
      (acc, key) => {
        if (tables.includes(key)) {
          acc[key] = schema.tables[key];
        }
        return acc;
      },
      {} as DatabaseSchema['tables'],
    );
    const newRelations = Object.entries(schema.relations).reduce(
      (acc, [key, value]) => {
        if (
          tables.includes(value.table) &&
          tables.includes(value.referencedTable)
        ) {
          acc.push(value);
        }
        return acc;
      },
      [] as DatabaseSchema['relations'],
    );
    return {
      tables: newTables,
      relations: newRelations,
    };
  }
}

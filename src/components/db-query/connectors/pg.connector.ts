import {BindingScope, inject, injectable} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {MAX_CONSTRAINT_NAME_LENGTH} from '../../../constant';
import {
  ColumnSchema,
  DatabaseSchema,
  ForeignKey,
  IDbConnector,
  TableSchema,
} from '../types';

@injectable({scope: BindingScope.TRANSIENT})
export class PgConnector implements IDbConnector {
  protected operatorMap: Record<string, string> = {
    string: 'TEXT',
    number: 'INTEGER',
    boolean: 'BOOLEAN',
    date: 'TIMESTAMP WITH TIME ZONE',
    object: 'JSONB',
    array: 'VARCHAR[]',
  };
  constructor(
    @inject(`datasources.db`)
    private readonly db: juggler.DataSource,
  ) {}

  async validate(query: string): Promise<void> {
    // remove the last semicolon if it exists
    const trimmedQuery = query.trim();
    if (trimmedQuery.endsWith(';')) {
      query = trimmedQuery.slice(0, -1);
    }
    await this.db.execute(`EXPLAIN ${query}`);
  }

  toDDL(dbSchema: DatabaseSchema): string {
    const ddlStatements: string[] = [];

    if (!dbSchema.tables) {
      return '';
    }
    // Create Tables
    for (const tableName in dbSchema.tables) {
      const table = dbSchema.tables[tableName];
      const columns = table.columns;
      const primaryKeys = table.primaryKey ?? [];
      const columnDefinitions = Object.keys(columns).map(columnName => {
        const column = columns[columnName];
        const dataType = this.mapColumnToDbType(columnName, column);
        const notNull = column.required || column.id ? ' NOT NULL' : '';
        let descriptionString = '';
        if (column.description) {
          descriptionString = ` -- ${column.description.replace(/'/g, "''")}\n`;
        }
        return `${descriptionString}  ${columnName} ${dataType}${notNull}`;
      });
      if (primaryKeys.length > 0) {
        columnDefinitions.push(`  PRIMARY KEY (${primaryKeys.join(', ')})`);
      }
      this._addTable(table, tableName, ddlStatements, columnDefinitions);
    }

    // Create Foreign Keys
    if (dbSchema.relations) {
      dbSchema.relations.forEach((relation: ForeignKey) => {
        const {table, column, referencedTable, referencedColumn} = relation;
        if (table && column && referencedTable && referencedColumn) {
          const constraintName = `fk_${table}_${column}`.substring(
            0,
            MAX_CONSTRAINT_NAME_LENGTH,
          ); // Identifier length limit in postgres
          const alterTableStatement = `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${column}) REFERENCES ${referencedTable} (${referencedColumn});`;
          ddlStatements.push(alterTableStatement);
        }
      });
    }

    return ddlStatements.join('\n\n');
  }

  private _addTable(
    table: TableSchema,
    tableName: string,
    ddlStatements: string[],
    columnDefinitions: string[],
  ) {
    const createTableStatement = `CREATE TABLE ${tableName} (\n${columnDefinitions.join(
      ',\n',
    )}\n);`;
    ddlStatements.push(createTableStatement);
    if (table.description) {
      ddlStatements.push(
        `COMMENT ON TABLE ${tableName} IS '${table.description.replace(
          /'/g,
          "''",
        )}';`,
      );
    }
  }

  protected mapDbTypeToColumnType(dbType: string): string {
    switch (dbType.toLowerCase()) {
      case 'text':
        return 'string';
      case 'integer':
      case 'bigint':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'timestamp with time zone':
        return 'date';
      case 'jsonb':
        return 'object';
      case 'varchar[]':
        return 'array';
      default:
        return 'string'; // Default to string for unknown types
    }
  }

  protected mapColumnToDbType(name: string, column: ColumnSchema): string {
    if (column.metadata?.postgresql?.dataType) {
      return column.metadata.postgresql.dataType.toUpperCase();
    }
    const {type, id} = column;
    const isId = !!id || name.endsWith('_id') || name.endsWith('Id');
    if (isId) {
      if (type === 'string') {
        return 'UUID';
      }
    }
    return this.operatorMap[type] || 'TEXT';
  }
}

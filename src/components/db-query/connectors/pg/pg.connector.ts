import {BindingScope, inject, injectable} from '@loopback/core';
import {HttpErrors} from '@loopback/rest';
import {AnyObject, juggler} from '@loopback/repository';
import {MAX_CONSTRAINT_NAME_LENGTH} from '../../../../constant';
import {
  ColumnSchema,
  DatabaseSchema,
  ForeignKey,
  IDbConnector,
  QueryParam,
  TableSchema,
} from '../../types';
import {AuthenticationBindings} from 'loopback4-authentication';
import {IAuthUserWithPermissions} from '@sourceloop/core';
import {ReaderDB} from '../../../../keys';
import {DbQueryAIExtensionBindings} from '../../keys';

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
    @inject(`datasources.${ReaderDB}`)
    protected readonly db: juggler.DataSource,
    @inject(AuthenticationBindings.CURRENT_USER, {optional: true})
    protected readonly user?: IAuthUserWithPermissions,
    @inject(DbQueryAIExtensionBindings.DefaultConditions, {optional: true})
    protected readonly defaultConditions?: AnyObject,
  ) {}

  async execute<T>(
    query: string,
    limit?: number,
    offset?: number,
    params: QueryParam[] = [],
  ): Promise<T[]> {
    if (!this.user?.tenantId) {
      throw new HttpErrors.Unauthorized('Not authorized to execute query.');
    }
    let limitOffsetQuery = '';
    const paramCount = params.length + 1;
    if (limit && offset) {
      limitOffsetQuery = ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
      params = [limit, offset];
    } else if (limit) {
      limitOffsetQuery = ` LIMIT $${paramCount}`;
      params = [limit];
    } else if (offset) {
      limitOffsetQuery = ` OFFSET $${paramCount}`;
      params = [offset];
    } else {
      params = [];
    }
    // Clean the query by removing trailing semicolons and comments
    const finalQuery = this._cleanQuery(query);
    return this._execute(
      `SELECT * FROM (${finalQuery}) AS subquery${limitOffsetQuery};`,
      params,
    );
  }

  async validate(query: string): Promise<void> {
    // Clean the query by removing trailing semicolons and comments
    const finalQuery = this._cleanQuery(query);
    await this._execute(`EXPLAIN ${finalQuery}`);
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

  protected async _execute(query: string, params: QueryParam[] = []) {
    return this.db.execute(query, params);
  }

  private _addTable(
    table: TableSchema,
    tableName: string,
    ddlStatements: string[],
    columnDefinitions: string[],
  ) {
    let createTableStatement = `CREATE TABLE ${tableName} (\n${columnDefinitions.join(
      ',\n',
    )}\n);`;
    if (table.description) {
      createTableStatement =
        `-- ${table.description.replace(/'/g, "''")}\n` + createTableStatement;
    }
    ddlStatements.push(createTableStatement);
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
  /**
   * Clean a SQL query by removing trailing semicolons and comments
   * @param query - The SQL query to clean
   * @returns The cleaned SQL query
   */
  private _cleanQuery(query: string): string {
    // Trim whitespace from the query
    let cleanedQuery = query.trim();

    // Remove trailing semicolons
    while (cleanedQuery.endsWith(';')) {
      cleanedQuery = cleanedQuery.slice(0, -1).trim();
    }

    // Remove trailing single-line comments (-- comment)
    const singleLineCommentRegex = /--.*$/;
    while (singleLineCommentRegex.test(cleanedQuery)) {
      cleanedQuery = cleanedQuery.replace(singleLineCommentRegex, '').trim();
      // Also remove any trailing semicolons that might have been left after comment removal
      while (cleanedQuery.endsWith(';')) {
        cleanedQuery = cleanedQuery.slice(0, -1).trim();
      }
    }

    // Remove trailing multi-line comments (/* comment */)
    const multiLineCommentRegex = /\/\*.*?\*\/\s*$/s;
    while (multiLineCommentRegex.test(cleanedQuery)) {
      cleanedQuery = cleanedQuery.replace(multiLineCommentRegex, '').trim();
      // Also remove any trailing semicolons that might have been left after comment removal
      while (cleanedQuery.endsWith(';')) {
        cleanedQuery = cleanedQuery.slice(0, -1).trim();
      }
    }

    return cleanedQuery;
  }
}

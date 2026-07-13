import {BindingScope, injectable} from '@loopback/core';
import {DatabaseSchema} from '../types';
import type {IDbConnector} from '../types';

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

  /** Names of every table in the loaded schema; [] when none is loaded. */
  allTableNames(): string[] {
    try {
      return Object.keys(this.get().tables);
    } catch {
      return [];
    }
  }

  /**
   * Read the filtered schema into a `{table: columns[]}` blob; returns `{}`
   * when the schema is empty/unloaded.
   */
  tablesWithColumns(tables: string[]): Record<string, string[]> {
    try {
      const schema = this.filteredSchema(tables);
      const out: Record<string, string[]> = {};
      for (const [tableName, tableDef] of Object.entries(schema.tables)) {
        out[tableName] = Object.keys(
          (tableDef as {columns?: Record<string, unknown>}).columns ?? {},
        );
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Build the RICH schema text for the SQL-gen prompt — the v2 representation
   * (`connector.toDDL(schema)`): CREATE TABLE blocks with column descriptions as
   * `-- comments`, `FOREIGN KEY` constraints (so the model sees how tables link),
   * and the table description. `toDDL` does NOT emit the per-table `context`
   * array, so it is appended as `-- [table] rule` lines. Returns `undefined`
   * (caller falls back to the bare name list) when the connector is missing or
   * the filtered schema is empty.
   *
   * This restores what the thin Mastra rewrite dropped: without relations +
   * descriptions the model cannot join related tables (e.g. revenue↔deal) and
   * refuses with "no link between the tables".
   */
  schemaForPrompt(
    dbConnector: IDbConnector | undefined,
    tables: string[],
  ): string | undefined {
    if (!dbConnector) return undefined;
    try {
      const filtered = this.filteredSchema(tables);
      if (!Object.keys(filtered.tables).length) return undefined;
      let ddl = dbConnector.toDDL(filtered);
      const contextLines: string[] = [];
      for (const [name, def] of Object.entries(filtered.tables)) {
        for (const line of (def as {context?: string[]}).context ?? []) {
          contextLines.push(`-- [${name}] ${line}`);
        }
      }
      if (contextLines.length) {
        ddl += `\n\n-- Table rules (follow these):\n${contextLines.join('\n')}`;
      }
      return ddl;
    } catch {
      return undefined;
    }
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

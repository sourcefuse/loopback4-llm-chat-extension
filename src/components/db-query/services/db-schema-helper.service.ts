import {inject} from '@loopback/core';
import {
  BelongsToDefinition,
  Entity,
  HasManyDefinition,
  PropertyType,
  RelationDefinitionBase,
  RelationDefinitionMap,
} from '@loopback/repository';
import {ModelConstructor} from '@sourceloop/core';
import {createHash} from 'crypto';
import {DbQueryAIExtensionBindings} from '../keys';
import {
  DatabaseSchema,
  ForeignKey,
  IDbConnector,
  ModelDefinitionWithName,
  RelationType,
  TableSchema,
} from '../types';

export class DbSchemaHelperService {
  constructor(
    @inject(DbQueryAIExtensionBindings.Connector)
    private readonly connector: IDbConnector,
  ) {}
  getTablesContext(schema: DatabaseSchema) {
    const tableContexts: string[] = [];
    Object.keys(schema.tables).forEach(table => {
      if (schema.tables[table]) {
        tableContexts.push(...schema.tables[table].context);
      }
    });
    return tableContexts;
  }

  asString(schema: DatabaseSchema): string {
    return this.connector.toDDL(schema);
  }

  computeHash(schema: DatabaseSchema): string {
    const schemaString = this.asString(schema);
    const sha256 = createHash('sha256');
    sha256.update(schemaString);
    return sha256.digest('hex');
  }

  modelToSchema(schema: string, models: ModelConstructor<Entity>[]) {
    // this function generates the DB Schema DDL from the Loopback4 Models
    const schemaDDL: DatabaseSchema = {
      tables: {},
      relations: [],
    };
    const tableMap = new Map<string, ModelDefinitionWithName>();
    const foreignKeysSet = new Set<string>();
    models.forEach(model => {
      let currentSchema = model.definition.settings.schema || schema;
      currentSchema = currentSchema ? `${currentSchema}.` : '';
      const modelName = `${currentSchema}${model.modelName.toLowerCase()}`;
      tableMap.set(model.modelName, {
        name: modelName,
        props: model.definition,
      });
    });
    models.forEach(model => {
      const foreignKeys = this.getForeignKeys(
        model.definition.relations ?? {},
        tableMap,
      );
      schemaDDL.relations.push(...foreignKeys.foreignKeys);
      foreignKeys.foreignKeySet.forEach(key => {
        foreignKeysSet.add(key);
      });
    });
    models.forEach(model => {
      const modelDef = tableMap.get(model.modelName);
      if (!modelDef) {
        return;
      }
      const modelName = modelDef.name;
      schemaDDL.tables[modelName] = {
        columns: {},
        primaryKey: [],
        description: model.definition.settings.description ?? '',
        context: model.definition.settings.context ?? [],
        hash: '',
      };

      const parseType = (type: PropertyType): string => {
        if (typeof type === 'function') {
          return type.name.toLowerCase();
        } else if (typeof type === 'object') {
          return 'unknown';
        } else {
          // do nothing
        }
        return type.toLowerCase();
      };

      const properties = model.definition.properties;
      Object.keys(properties).forEach(prop => {
        const property = properties[prop];
        const columnName = property.name || prop.toLowerCase();
        schemaDDL.tables[modelName].columns[columnName] = {
          type: parseType(property.type),
          required: property.required || false,
          description: property.description || '',
          id: (property.id ?? foreignKeysSet.has(prop) ?? false) as boolean,
          metadata: property.metadata || {},
        };
        if (property.id) {
          schemaDDL.tables[modelName].primaryKey.push(prop);
        }
      });
      schemaDDL.tables[modelName].hash = this.hashTable({
        ...schemaDDL.tables[modelName],
        hash: '',
      });
    });
    return schemaDDL;
  }

  private getForeignKeys(
    relations: RelationDefinitionMap,
    tableMap: Map<string, ModelDefinitionWithName>,
  ) {
    const foreignKeys: ForeignKey[] = [];
    const foreignKeySet = new Set<string>();
    Object.keys(relations).forEach(relationName => {
      const relation = relations[relationName];
      if (this._isBelongsTo(relation)) {
        this._addBelongsTo(tableMap, relation, foreignKeys, foreignKeySet);
      } else if (this._isHasManyThrough(relation)) {
        this._addHasManyThrough(tableMap, relation, foreignKeys, foreignKeySet);
      } else {
        // do nothing for other relation types
      }
    });
    return {foreignKeys, foreignKeySet};
  }

  private _addHasManyThrough(
    tableMap: Map<string, ModelDefinitionWithName>,
    relation: HasManyDefinition & Required<Pick<HasManyDefinition, 'through'>>,
    foreignKeys: ForeignKey[],
    foreignKeySet: Set<string>,
  ) {
    const sourceModelDef = tableMap.get(relation.source.modelName);
    const targetModelDef = tableMap.get(relation.target().modelName);
    const throughModelDef = tableMap.get(relation.through.model().modelName);
    if (!throughModelDef || !sourceModelDef || !targetModelDef) {
      return;
    }
    foreignKeys.push({
      type: RelationType.HasManyThrough,
      table: throughModelDef.name,
      column: this._getColumnName(
        throughModelDef,
        relation.through.keyFrom,
        true,
      ),
      referencedTable: sourceModelDef.name,
      referencedColumn: this._getColumnName(
        sourceModelDef,
        relation.keyFrom,
        true,
      ),
      description: `left side of has many through relation from ${sourceModelDef.name} to ${targetModelDef.name} via ${throughModelDef.name}`,
    });
    foreignKeys.push({
      type: RelationType.HasManyThrough,
      table: throughModelDef.name,
      column: this._getColumnName(throughModelDef, relation.through.keyTo),
      referencedTable: targetModelDef.name,
      referencedColumn: this._getColumnName(targetModelDef, relation.keyTo),
      description: `right side of has many through relation from ${sourceModelDef.name} to ${targetModelDef.name} via ${throughModelDef.name}`,
    });
    foreignKeySet.add(relation.through.keyFrom ?? '');
    foreignKeySet.add(relation.through.keyTo ?? '');
  }

  private _addBelongsTo(
    tableMap: Map<string, ModelDefinitionWithName>,
    relation: BelongsToDefinition & {description?: string},
    foreignKeys: ForeignKey[],
    foreignKeySet: Set<string>,
  ) {
    const sourceModelDef = tableMap.get(relation.source.modelName);
    const targetModelDef = tableMap.get(relation.target().modelName);
    if (!targetModelDef || !sourceModelDef) {
      return;
    }
    foreignKeys.push({
      type: RelationType.BelongsTo,
      table: sourceModelDef.name,
      column: this._getColumnName(sourceModelDef, relation.keyFrom, true),
      referencedTable: targetModelDef.name,
      referencedColumn: this._getColumnName(targetModelDef, relation.keyTo),
      description: relation.description ?? '',
    });
    foreignKeySet.add(relation.keyFrom ?? '');
  }

  private _isBelongsTo(
    relation: RelationDefinitionBase | BelongsToDefinition,
  ): relation is BelongsToDefinition & {description?: string} {
    return relation.type === 'belongsTo';
  }

  private _isHasManyThrough(
    relation: RelationDefinitionBase | HasManyDefinition,
  ): relation is HasManyDefinition &
    Required<Pick<HasManyDefinition, 'through'>> & {description?: string} {
    return (
      relation.type === 'hasMany' && !!(relation as HasManyDefinition).through
    );
  }

  private hashTable(table: TableSchema) {
    const columnsHash = JSON.stringify(table);
    const sha256 = createHash('sha256');
    sha256.update(columnsHash);
    return sha256.digest('hex');
  }

  private _defaultKeyTo(tableName: string): string {
    if (!this._pascalCase(tableName)) {
      return 'id';
    }
    return `${this._pascalCase(tableName)}Id`;
  }

  private _defaultKeyFrom(tableName: string): string {
    return `id`;
  }

  private _pascalCase(str: string): string {
    const [, table] = str.split('.');
    return (table ?? '')
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  }

  private _getColumnName(
    modelDef: ModelDefinitionWithName,
    prop?: string,
    from = false,
  ): string {
    if (!prop) {
      if (from) {
        prop = this._defaultKeyFrom(modelDef.props.name);
      } else {
        prop = this._defaultKeyTo(modelDef.props.name);
      }
    }
    return modelDef.props.properties[prop]?.name ?? prop.toLowerCase();
  }
}

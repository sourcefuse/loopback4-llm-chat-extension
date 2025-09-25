import {
  AnyObject,
  Count,
  DataObject,
  Entity,
  Filter,
  FilterExcludingWhere,
  ModelDefinition,
  Where,
} from '@loopback/repository';
import {ModelConstructor} from '@sourceloop/core';
import {SupportedDBs} from '../../types';
import {DatasetActionType} from './constant';

export enum EvaluationResult {
  Pass = 'pass',
  QueryError = 'query_error',
  TableError = 'table_not_found',
}

export enum GenerationError {
  Failed = 'failed',
}

export enum DatasetFeedback {
  Accepted = 'accept',
  QueryIssue = 'query_issue',
  OtherIssue = 'other_issue',
}

export enum CacheResults {
  AsIs = 'as-is',
  Similar = 'similar',
  NotRelevant = 'not-relevant',
}

export enum Errors {
  PermissionError = 'permission_error',
}

export enum RelationType {
  BelongsTo = 'belongsTo',
  HasMany = 'hasMany',
  HasOne = 'hasOne',
  HasManyThrough = 'hasManyThrough',
}

export type Status =
  | EvaluationResult
  | DatasetFeedback
  | Errors
  | GenerationError;

export type DatasetServiceConfig = {};

export type ColumnSchema = {
  type: string;
  required: boolean;
  description?: string;
  id: boolean;
  metadata?: Record<string, AnyObject[string]>;
};
export type TableSchema = {
  columns: Record<string, ColumnSchema>;
  primaryKey: string[];
  description: string;
  context: (string | Record<string, string>)[];
  hash: string;
};
export type ForeignKey = {
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  type: RelationType;
  description?: string;
};
export type DatabaseSchema = {
  tables: Record<string, TableSchema>;
  relations: ForeignKey[];
};

export type IModelConfig = {
  model: ModelConstructor<Entity>;
  readPermissionKey: string;
};

export type ModelDefinitionWithName = {
  name: string;
  props: ModelDefinition;
};

export type DbQueryConfig = {
  models: IModelConfig[];
  db?: {
    schema?: string;
    dialect: SupportedDBs;
    ignoredColumns?: string[];
  };
  readAccessForAI?: boolean;
  maxRowsForAI?: number;
  noKnowledgeGraph?: boolean;
  knowledgeGraph?: {
    // value between 0 and 1 indicating the weight of the knowledge graph in the query evaluation
    graphWeight: number;
    // value between 0 and 1 indicating the weight of the vector similarity in the query evaluation
    vectorWeight: number;
    // similarity threshold for considering two tables in same cluster
    clusterThreshold?: number;
    // concept threshold to consider an LLM recognized concept
    conceptThreshold?: number;
    // max cluster size
    maxClusterSize?: number;
  };
  nodes?: {
    sqlGenerationWithDescription?: boolean;
  };
  columnSelection?: boolean;
};

export type IDatasetAction = {
  datasetId: string;
  userId: string;
  action: DatasetActionType;
  comment?: string | null;
};

export type IDataSet = {
  tenantId: string;
  query: string;
  description: string;
  tables: string[];
  schemaHash: string;
  votes: number;
  prompt: string;
  createdBy?: string;
  id?: string;
};

export type IDatasetWithActions = IDataSet & {
  actions?: IDatasetAction[];
};

export interface IDataSetStore {
  findById(
    id: string,
    filter?: FilterExcludingWhere<IDataSet>,
  ): Promise<IDatasetWithActions>;
  find(filter?: Filter<IDataSet>): Promise<IDatasetWithActions[]>;
  create(data: IDataSet): Promise<IDataSet>;
  updateById(id: string, data: DataObject<IDataSet>): Promise<void>;
  updateAll(
    data: DataObject<IDataSet>,
    where?: Where<IDataSet>,
  ): Promise<Count>;
  getData<T extends AnyObject>(
    id: string,
    limit?: number,
    offset?: number,
  ): Promise<T[]>;
  updateLikes(
    datasetId: string,
    liked: boolean | null,
    comment?: string,
  ): Promise<IDataSet>;
  getLikes(datasetId: string): Promise<IDatasetAction | null>;
}

export enum DbQueryStoredTypes {
  DataSet = 'dataset',
  Table = 'table',
  SchemaHash = 'schema_hash',
  Context = 'context',
  KnowledgeGraph = 'knowledge_graph',
}

export type CachedKnowledgeGraph = {
  hash: string;
  graph: string;
};

export type QueryCacheMetadata = {
  datasetId: string;
  query: string;
  type: DbQueryStoredTypes.DataSet;
};

export type QueryParam = string | number;

export interface IDbConnector {
  execute<T>(
    query: string,
    limit?: number,
    offset?: number,
    params?: QueryParam[],
  ): Promise<T[]>;
  validate(query: string): Promise<void>;
  toDDL(dbSchema: DatabaseSchema): string;
}

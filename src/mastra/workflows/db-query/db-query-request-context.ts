import type {RequestContext} from '@mastra/core/request-context';
import type {MastraLanguageModel} from '@mastra/core/agent';
import type {IAuthUserWithPermissions} from '@sourceloop/core';
import type {
  DatabaseSchema,
  DbQueryConfig,
  IDataSetStore,
  IDbConnector,
  QueryTemplateMetadata,
} from '../../../components/db-query/types';
import type {DbSchemaHelperService} from '../../../components/db-query/services/db-schema-helper.service';
import type {PermissionHelper} from '../../../components/db-query/services/permission-helper.service';
import type {TableSearchService} from '../../../components/db-query/services/search/table-search.service';
import type {TemplateHelper} from '../../../components/db-query/services/template-helper.service';
import type {DataSetHelper} from '../../../components/db-query/services/dataset-helper.service';
import type {SchemaStore} from '../../../components/db-query/services/schema.store';

/**
 * Typed interface for all values stored in Mastra RequestContext
 * for the DBQueryWorkflow.
 */
export interface DbQueryRequestContext {
  /** Cheap/fast LLM for most DBQuery nodes */
  cheapLlm: MastraLanguageModel;
  /** Smart/powerful LLM for complex SQL generation */
  smartLlm: MastraLanguageModel;
  /** Smart non-thinking LLM (for checklist verification) */
  smartNonThinkingLlm: MastraLanguageModel | undefined;
  /** DBQuery configuration */
  dbQueryConfig: DbQueryConfig;
  /** Dataset store for persistence */
  datasetStore: IDataSetStore;
  /** Database connector for SQL validation/execution */
  connector: IDbConnector;
  /** Schema store (in-memory cached schema) */
  schemaStore: SchemaStore;
  /** Schema helper (DDL generation, hash, context extraction) */
  schemaHelper: DbSchemaHelperService;
  /** Permission helper for table access control */
  permissionHelper: PermissionHelper | undefined;
  /** Table search service (knowledge graph + vector) */
  tableSearchService: TableSearchService;
  /** Template helper for query template resolution */
  templateHelper: TemplateHelper;
  /** Dataset helper for permissions and data access */
  datasetHelper: DataSetHelper;
  /** Query cache retriever */
  queryCache: {invoke(query: string): Promise<CacheDocument[]>};
  /** Template cache retriever */
  templateCache: {invoke(query: string): Promise<TemplateDocument[]>};
  /** Global context rules/checks */
  globalContext: string[];
  /** Abort signal from HTTP request */
  abortSignal: AbortSignal;
  /** Authenticated user */
  currentUser: IAuthUserWithPermissions;
  /** Full database schema (unfiltered) */
  fullSchema: DatabaseSchema;
  /** Whether this is a direct internal call (not from chat tool) */
  directCall: boolean;
}

/** Document returned by the query cache retriever */
export interface CacheDocument {
  pageContent: string;
  metadata: {
    datasetId: string;
    query: string;
    description: string;
    votes: number;
  };
}

/** Document returned by the template cache retriever */
export interface TemplateDocument {
  pageContent: string;
  metadata: QueryTemplateMetadata;
}

/**
 * Helper: cast an untyped Mastra RequestContext to the DbQuery typed variant.
 */
export function asDbQueryContext(
  requestContext: RequestContext,
): RequestContext<DbQueryRequestContext> {
  return requestContext as RequestContext<DbQueryRequestContext>;
}

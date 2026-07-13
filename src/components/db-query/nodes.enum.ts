/**
 * db-query graph node keys. Each value is the node id used as (a) the workflow
 * step id, (b) the DI resolver key, and (c) the `@graphNode(key)` discovery tag —
 * all three derive from the same enum member so they stay in lock-step.
 *
 * NOTE: the improve terminal node keeps the id `Failed` ('failed') inside its own
 * workflow, but its DI *resolver key* must be globally unique, so it is
 * registered/tagged as `ImproveFailed` ('improve_failed').
 */
export enum DbQueryNodes {
  // Entry dispatch (restores the LangGraph `IsImprovement` node): the single
  // db-query graph branches here on `datasetId` — present → improve path,
  // absent → generate path. Keeps LangGraph's "one graph, two entrypoints".
  IsImprovement = 'is_improvement',
  CheckCache = 'check_cache',
  GetTables = 'get_tables',
  CheckPermissions = 'check_permissions',
  CheckTemplates = 'check_templates',
  GetColumns = 'get_columns',
  ClassifyChange = 'classify_change',
  // The v2 generate/validate loop nodes, restored 1:1 (SqlGeneration →
  // parallel[SyntacticValidator, SemanticValidator, GenerateDescription] →
  // PostValidation), run inside a Mastra `.dountil` loop.
  SqlGeneration = 'sql_generation',
  SyntacticValidator = 'syntactic_validator',
  SemanticValidator = 'semantic_validator',
  GenerateDescription = 'generate_description',
  PostValidation = 'post_validation',
  ReturnCached = 'return_cached',
  SaveFromTemplate = 'save_dataset_from_template',
  PostCacheAndTables = 'post_cache_and_tables',
  SaveDataset = 'save_dataset',
  GenerateChecklist = 'generate_checklist',
  VerifyChecklist = 'verify_checklist',
  Failed = 'failed',
  LoadExisting = 'load_existing',
  FixQuery = 'fix_query',
  SaveImproved = 'save_improved',
  ImproveFailed = 'improve_failed',
}

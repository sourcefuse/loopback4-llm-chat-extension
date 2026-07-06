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
  CheckCache = 'check_cache',
  GetTables = 'get_tables',
  CheckTemplates = 'check_templates',
  GetColumns = 'get_columns',
  SqlAndValidate = 'sql_and_validate',
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
